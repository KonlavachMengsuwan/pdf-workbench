//! Narrow native boundary. Files enter only via a native picker or an explicitly
//! selected project. No renderer command accepts an arbitrary filesystem path.
mod optimization;
use optimization::Optimization;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, State};

const MAX_BYTES: u64 = 50 * 1024 * 1024;
const MAX_PAGES: usize = 1000;
const MAX_CHUNK: usize = 256 * 1024;
const MAX_JSON: u64 = 64 * 1024 * 1024;
const MAX_PROJECT: u64 = 8 * 1024 * 1024;
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
    pub kind: String,
    pub features: Vec<String>,
    pub editable: bool,
    #[serde(default)]
    pub preserve_document: bool,
    #[serde(default)]
    pub can_create_editing_copy: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed_features: Vec<String>,
    pub pages: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageRef {
    source_id: String,
    page: usize,
    rotation: i32,
}

#[derive(Debug, Deserialize)]
struct PreservePage {
    page: usize,
    rotation: i32,
    crop: Option<CropMargins>,
}
#[derive(Debug, Deserialize)]
struct CropMargins {
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
}

#[derive(Debug, Deserialize)]
struct BatchItem {
    id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportReport {
    path: String,
    bytes: u64,
    input_bytes: u64,
    sha256: String,
    elapsed_ms: u128,
    validation: Vec<String>,
    source: Source,
    optimization: Option<Value>,
}

struct Stage {
    path: PathBuf,
    name: String,
    kind: String,
    size: u64,
}
struct Inner {
    home: PathBuf,
    initialize_home: bool,
    engine: PathBuf,
    sources: Mutex<HashMap<String, Source>>,
    stages: Mutex<HashMap<String, Stage>>,
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    busy: AtomicBool,
    metrics: Mutex<Vec<Value>>,
}
#[derive(Clone)]
struct Backend(Arc<Inner>);

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn text_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

impl Backend {
    fn ensure_home(&self) -> Result<()> {
        // The installed app lazily creates its own per-user data directory.
        // An explicit workspace is strict: a missing volume never gets a fallback.
        if self.0.initialize_home {
            fs::create_dir_all(self.0.home.join("tmp")).map_err(err)?;
            fs::create_dir_all(self.0.home.join("projects")).map_err(err)?;
            let marker = self.0.home.join(".pdfworkbench-workspace");
            if !marker.exists() {
                fs::write(marker, "PDF Workbench managed workspace\n").map_err(err)?;
            }
        }
        if !self.0.home.is_dir() || !self.0.home.join(".pdfworkbench-workspace").is_file() {
            return Err("The PDF Workbench workspace is unavailable. Reconnect the configured volume or restore the workspace; no fallback location was created.".into());
        }
        if !self.0.home.join("tmp").is_dir() {
            return Err("The workspace temporary directory is missing. Restore the project's tmp directory before processing.".into());
        }
        Ok(())
    }
    fn temp(&self, suffix: &str) -> Result<PathBuf> {
        self.ensure_home()?;
        Ok(self
            .0
            .home
            .join("tmp")
            .join(format!("{}{}", new_id(), suffix)))
    }
    fn get(&self, id: &str) -> Result<Source> {
        self.0.sources.lock().map_err(err)?.get(id).cloned().ok_or_else(|| "This file is not authorized in the current session. Open it again or reopen its project.".into())
    }
    fn job(&self, id: Option<String>) -> Result<Job> {
        if self
            .0
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("Another native PDF job is running. Wait for it or cancel it before starting this job.".into());
        }
        let id = id.unwrap_or_else(new_id);
        let token = Arc::new(AtomicBool::new(false));
        self.0
            .jobs
            .lock()
            .map_err(err)?
            .insert(id.clone(), token.clone());
        Ok(Job {
            backend: self.clone(),
            id,
            token,
        })
    }
    fn inspect(
        &self,
        path: &Path,
        id: Option<String>,
        kind: &str,
        token: &AtomicBool,
    ) -> Result<Source> {
        self.ensure_home()?;
        let path = fs::canonicalize(path).map_err(|e| format!("Cannot read selected file: {e}"))?;
        let bytes = fs::metadata(&path).map_err(err)?.len();
        if bytes == 0 || bytes > MAX_BYTES {
            return Err(
                "Files must contain data and be no larger than 50 MiB in this release.".into(),
            );
        }
        let (features, pages, preserve_document, can_create_editing_copy) = if kind == "pdf" {
            let probe = self.qpdf(
                &[
                    "--json=2".into(),
                    "--json-stream-data=none".into(),
                    text_path(&path),
                ],
                token,
                MAX_JSON,
            )?;
            let value: Value = serde_json::from_slice(&probe)
                .map_err(|e| format!("Cannot read PDF preflight report: {e}"))?;
            let pages = value
                .get("pages")
                .and_then(Value::as_array)
                .map(Vec::len)
                .ok_or("qpdf did not return a page inventory")?;
            if pages == 0 || pages > MAX_PAGES {
                return Err("This release supports PDFs with 1–1000 pages.".into());
            }
            let features = inventory(&value);
            if features.iter().any(|f| f == "encryption") {
                return Err("Encrypted PDFs are unsupported in this release. The app does not decrypt or modify them.".into());
            }
            let (preserve, editing_copy) = capabilities(&value, &features);
            (features, pages, preserve, editing_copy)
        } else {
            validate_magic(&path, kind)?;
            (vec![], 0, false, false)
        };
        cancelled(token)?;
        let source = Source {
            id: id.unwrap_or_else(new_id),
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            path: text_path(&path),
            bytes,
            sha256: hash_file(&path)?,
            kind: kind.into(),
            editable: features.is_empty(),
            preserve_document,
            can_create_editing_copy,
            removed_features: vec![],
            features,
            pages,
        };
        cancelled(token)?;
        Ok(source)
    }
    fn register(
        &self,
        path: &Path,
        id: Option<String>,
        kind: &str,
        token: &AtomicBool,
    ) -> Result<Source> {
        let source = self.inspect(path, id, kind, token)?;
        self.0
            .sources
            .lock()
            .map_err(err)?
            .insert(source.id.clone(), source.clone());
        Ok(source)
    }
    fn qpdf(&self, args: &[String], token: &AtomicBool, max: u64) -> Result<Vec<u8>> {
        self.ensure_home()?;
        cancelled(token)?;
        if !self.0.engine.is_file() {
            return Err("The bundled qpdf engine is missing. Reinstall or rebuild this app; a system engine is never used as a fallback.".into());
        }
        let out = tempfile::NamedTempFile::new_in(self.0.home.join("tmp")).map_err(err)?;
        let stderr = tempfile::NamedTempFile::new_in(self.0.home.join("tmp")).map_err(err)?;
        let mut command = Command::new(&self.0.engine);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(out.reopen().map_err(err)?)
            .stderr(stderr.reopen().map_err(err)?);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start bundled qpdf: {e}"))?;
        let started = Instant::now();
        let status = loop {
            let output_over = args
                .last()
                .and_then(|p| fs::metadata(p).ok())
                .map(|m| m.len() > MAX_BYTES)
                .unwrap_or(false);
            let over = output_over
                || out.as_file().metadata().map_err(err)?.len() > max
                || stderr.as_file().metadata().map_err(err)?.len() > 1024 * 1024;
            if token.load(Ordering::SeqCst) || started.elapsed() > Duration::from_secs(180) || over
            {
                let _ = child.kill();
                let _ = child.wait();
                if over {
                    return Err("PDF processing exceeded the 50 MiB output or safe report-size limit; reduce the output page count.".into());
                }
                if started.elapsed() > Duration::from_secs(180) {
                    return Err("The PDF engine exceeded the 180-second job limit.".into());
                }
                return Err("Job cancelled. Existing files were not changed.".into());
            }
            if let Some(status) = child.try_wait().map_err(err)? {
                break status;
            }
            thread::sleep(Duration::from_millis(25));
        };
        // Exit 3 is a qpdf warning. Reject rather than silently repairing input.
        if !status.success() {
            let detail = fs::read_to_string(stderr.path()).unwrap_or_default();
            let detail: String = detail.chars().take(2000).collect();
            return Err(format!("PDF engine rejected this file or operation (warnings are not silently repaired): {detail}"));
        }
        cancelled(token)?;
        if out.as_file().metadata().map_err(err)?.len() > max {
            return Err("PDF report exceeded its size limit.".into());
        }
        fs::read(out.path()).map_err(err)
    }
    fn verify_source(&self, source: &Source) -> Result<()> {
        if fs::metadata(&source.path)
            .map_err(|_| format!("Source file is unavailable: {}", source.name))?
            .len()
            != source.bytes
            || hash_file(Path::new(&source.path))? != source.sha256
        {
            return Err(format!(
                "{} changed since it was opened. Reopen it before continuing.",
                source.name
            ));
        }
        Ok(())
    }
}

struct Job {
    backend: Backend,
    id: String,
    token: Arc<AtomicBool>,
}
impl Drop for Job {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.backend.0.jobs.lock() {
            jobs.remove(&self.id);
        }
        self.backend.0.busy.store(false, Ordering::SeqCst);
    }
}
fn cancelled(token: &AtomicBool) -> Result<()> {
    if token.load(Ordering::SeqCst) {
        Err("Job cancelled. Existing files were not changed.".into())
    } else {
        Ok(())
    }
}

/// Examine qpdf's parsed object graph, never raw content strings. This is an
/// intentionally conservative preservation boundary, not a PDF conformance claim.
fn inventory(value: &Value) -> Vec<String> {
    let mut found = BTreeSet::new();
    if value.pointer("/encrypt/encrypted").and_then(Value::as_bool) == Some(true) {
        found.insert("encryption".to_owned());
    }
    fn walk(v: &Value, found: &mut BTreeSet<String>) {
        match v {
            Value::Object(map) => {
                for (key, child) in map {
                    let label = match key.as_str() {
                        "/AcroForm" | "/XFA" => Some("forms"),
                        "/Annots" if child.as_array().map(|a| !a.is_empty()).unwrap_or(true) => {
                            Some("annotations or links")
                        }
                        "/Outlines" => Some("bookmarks"),
                        "/StructTreeRoot" | "/MarkInfo" | "/RoleMap" | "/StructParent"
                        | "/StructParents" => Some("accessibility tags"),
                        "/Encrypt" => Some("encryption"),
                        "/ByteRange" | "/Perms" | "/DocMDP" => {
                            Some("digital signatures (unverified)")
                        }
                        "/EmbeddedFiles" | "/EF" | "/AF" | "/Collection" => {
                            Some("attachments or portfolios")
                        }
                        "/OCProperties" | "/OC" => Some("optional content layers"),
                        "/PageLabels" => Some("page labels"),
                        "/Dests" | "/Dest" => Some("named or explicit destinations"),
                        "/AA" => Some("additional actions"),
                        "/JavaScript" | "/JS" => Some("JavaScript actions"),
                        "/Names" => Some("document name trees"),
                        "/Metadata" => Some("XMP metadata"),
                        "/OutputIntents" => Some("output intents"),
                        "/Threads" => Some("article threads"),
                        "/B" if map.get("/Type").and_then(Value::as_str) == Some("/Page") => {
                            Some("article threads")
                        }
                        "/UserUnit" => Some("nonstandard page units"),
                        "/PieceInfo" | "/SpiderInfo" | "/SeparationInfo" => {
                            Some("application-specific document structures")
                        }
                        _ => None,
                    };
                    if let Some(label) = label {
                        found.insert(label.to_string());
                    }
                    if key == "/FT" && child.as_str() == Some("/Sig") {
                        found.insert("digital signatures (unverified)".into());
                    }
                    walk(child, found);
                }
            }
            Value::Array(arr) => {
                for v in arr {
                    walk(v, found);
                }
            }
            _ => {}
        }
    }
    walk(value, &mut found);
    if let Ok(objects) = object_map(value) {
        for object in objects.values() {
            let Some(dict) = object_dict(object) else {
                continue;
            };
            if let Some(open) = dict.get("/OpenAction") {
                found.insert(
                    if safe_opening_view(value, open) {
                        "document opening view"
                    } else {
                        "unsupported opening action"
                    }
                    .into(),
                );
            }
            if dict.get("/Type").and_then(Value::as_str) == Some("/Action")
                || dict.contains_key("/S")
                    && (dict.contains_key("/URI")
                        || dict.contains_key("/JS")
                        || dict.contains_key("/Next"))
            {
                found.insert(
                    if safe_action(value, &Value::Object(dict.clone())) {
                        "navigation actions"
                    } else if dict.get("/S").and_then(Value::as_str) == Some("/JavaScript") {
                        "JavaScript actions"
                    } else {
                        "unsupported actions"
                    }
                    .into(),
                );
            }
            if dict.get("/Type").and_then(Value::as_str) == Some("/Catalog")
                && dict.keys().any(|key| !CATALOG_KEYS.contains(&key.as_str()))
            {
                found.insert("unsupported catalog structures".into());
            }
            if let Some(action) = dict.get("/A") {
                // /A is also a Type3 glyph name or structure layout attribute.
                // Only annotation and outline contexts assign action semantics.
                let action_context = dict.get("/Type").and_then(Value::as_str) == Some("/Annot")
                    || dict.contains_key("/Subtype") && dict.contains_key("/Rect")
                    || dict.contains_key("/Title")
                        && (dict.contains_key("/Parent") || dict.contains_key("/Dest"));
                if action_context && !safe_action(value, action) {
                    found.insert("unsupported actions".into());
                }
            }
        }
    } else if value.get("/OpenAction").is_some() {
        found.insert("unsupported opening action".into());
    }
    found.into_iter().collect()
}

const CATALOG_KEYS: &[&str] = &[
    "/Type",
    "/Pages",
    "/Metadata",
    "/StructTreeRoot",
    "/MarkInfo",
    "/Lang",
    "/Outlines",
    "/Names",
    "/Dests",
    "/PageLabels",
    "/OpenAction",
    "/ViewerPreferences",
    "/PageMode",
    "/PageLayout",
    "/Version",
];
type ObjectMap = serde_json::Map<String, Value>;
type Changes = HashMap<String, HashMap<String, Option<Value>>>;

fn object_map(report: &Value) -> Result<&ObjectMap> {
    report
        .pointer("/qpdf/1")
        .and_then(Value::as_object)
        .ok_or_else(|| "Missing qpdf object graph".into())
}
fn object_dict(object: &Value) -> Option<&ObjectMap> {
    object
        .get("value")
        .and_then(Value::as_object)
        .or_else(|| object.pointer("/stream/dict").and_then(Value::as_object))
}
fn is_ref(s: &str) -> bool {
    let parts: Vec<_> = s.split(' ').collect();
    parts.len() == 3
        && parts[2] == "R"
        && parts[..2]
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
}
fn resolve<'a>(report: &'a Value, mut value: &'a Value) -> Option<&'a Value> {
    for _ in 0..64 {
        let Some(reference) = value.as_str().filter(|s| is_ref(s)) else {
            return Some(value);
        };
        value = object_map(report)
            .ok()?
            .get(&format!("obj:{reference}"))?
            .get("value")?;
    }
    None
}
fn safe_destination(report: &Value, value: &Value) -> bool {
    let Some(value) = resolve(report, value) else {
        return false;
    };
    if let Some(array) = value.as_array() {
        return array.len() >= 2
            && array.len() <= 6
            && array[0]
                .as_str()
                .filter(|s| is_ref(s))
                .and_then(|s| object_map(report).ok()?.get(&format!("obj:{s}")))
                .and_then(object_dict)
                .and_then(|d| d.get("/Type"))
                .and_then(Value::as_str)
                == Some("/Page")
            && [
                "/XYZ", "/Fit", "/FitH", "/FitV", "/FitR", "/FitB", "/FitBH", "/FitBV",
            ]
            .contains(&array[1].as_str().unwrap_or(""))
            && array[2..]
                .iter()
                .all(|n| n.is_null() || n.as_f64().map(f64::is_finite).unwrap_or(false));
    }
    // Named destinations are passive references. The graph comparator preserves
    // both the reference and destination tree, without resolving or executing it.
    value
        .as_str()
        .map(|s| s.starts_with("u:") || s.starts_with("b:") || s.starts_with('/'))
        .unwrap_or(false)
}
fn safe_action(report: &Value, action: &Value) -> bool {
    let Some(dict) = resolve(report, action).and_then(Value::as_object) else {
        return false;
    };
    if dict.contains_key("/Next") || dict.contains_key("/JS") {
        return false;
    }
    match dict.get("/S").and_then(Value::as_str) {
        Some("/URI") => {
            dict.keys()
                .all(|k| ["/Type", "/S", "/URI", "/IsMap"].contains(&k.as_str()))
                && dict.get("/URI").and_then(Value::as_str).is_some()
        }
        Some("/GoTo") => {
            dict.keys()
                .all(|k| ["/Type", "/S", "/D"].contains(&k.as_str()))
                && dict
                    .get("/D")
                    .map(|d| safe_destination(report, d))
                    .unwrap_or(false)
        }
        _ => false,
    }
}
fn safe_opening_view(report: &Value, value: &Value) -> bool {
    safe_destination(report, value)
        || resolve(report, value)
            .and_then(Value::as_object)
            .map(|d| {
                d.get("/S").and_then(Value::as_str) == Some("/GoTo") && safe_action(report, value)
            })
            .unwrap_or(false)
}
fn capabilities(report: &Value, features: &[String]) -> (bool, bool) {
    const ALLOWED: &[&str] = &[
        "annotations or links",
        "bookmarks",
        "accessibility tags",
        "XMP metadata",
        "page labels",
        "named or explicit destinations",
        "document name trees",
        "document opening view",
        "navigation actions",
    ];
    if features.iter().any(|f| !ALLOWED.contains(&f.as_str())) {
        return (false, false);
    }
    let Ok(objects) = object_map(report) else {
        return (false, false);
    };
    let mut invisible = true;
    for object in objects.values() {
        let Some(dict) = object_dict(object) else {
            continue;
        };
        if let Some(names) = dict.get("/Names") {
            if dict.get("/Type").and_then(Value::as_str) == Some("/Catalog")
                && !resolve(report, names)
                    .and_then(Value::as_object)
                    .map(|n| n.keys().all(|k| k == "/Dests"))
                    .unwrap_or(false)
            {
                return (false, false);
            }
        }
        if let Some(annotations) = dict.get("/Annots") {
            let Some(annotations) = resolve(report, annotations).and_then(Value::as_array) else {
                return (false, false);
            };
            for annotation in annotations {
                let Some(a) = resolve(report, annotation).and_then(Value::as_object) else {
                    return (false, false);
                };
                if a.get("/Subtype").and_then(Value::as_str) != Some("/Link")
                    || a.keys().any(|k| {
                        ![
                            "/Type",
                            "/Subtype",
                            "/Rect",
                            "/Contents",
                            "/P",
                            "/NM",
                            "/M",
                            "/F",
                            "/Border",
                            "/C",
                            "/StructParent",
                            "/A",
                            "/Dest",
                            "/H",
                            "/PA",
                            "/QuadPoints",
                            "/BS",
                            "/AP",
                            "/AS",
                        ]
                        .contains(&k.as_str())
                    })
                    || a.contains_key("/PA")
                {
                    return (false, false);
                }
                if a.get("/A")
                    .map(|v| !safe_action(report, v))
                    .unwrap_or(false)
                    || a.get("/Dest")
                        .map(|v| !safe_destination(report, v))
                        .unwrap_or(false)
                {
                    return (false, false);
                }
                let border = a.get("/Border").map(|v| {
                    resolve(report, v)
                        .and_then(Value::as_array)
                        .filter(|v| v.len() >= 3)
                        .and_then(|v| v[2].as_f64())
                        == Some(0.0)
                });
                let bs = a.get("/BS").map(|v| {
                    resolve(report, v)
                        .and_then(Value::as_object)
                        .and_then(|d| d.get("/W"))
                        .and_then(Value::as_f64)
                        == Some(0.0)
                });
                invisible &= !a.contains_key("/AP")
                    && (border == Some(true) || bs == Some(true))
                    && border != Some(false)
                    && bs != Some(false);
            }
        }
    }
    (true, invisible)
}

fn graph_report(
    backend: &Backend,
    path: &Path,
    token: &AtomicBool,
    decoded: bool,
) -> Result<Value> {
    let mut args = if decoded {
        vec![
            "--json-output=2".into(),
            "--json-stream-data=inline".into(),
            "--decode-level=generalized".into(),
        ]
    } else {
        vec!["--json=2".into(), "--json-stream-data=none".into()]
    };
    args.push(text_path(path));
    let bytes = backend.qpdf(&args, token, MAX_JSON)?;
    cancelled(token)?;
    serde_json::from_slice(&bytes).map_err(|e| format!("Cannot parse bounded PDF graph: {e}"))
}

/// Compare reachable PDF semantics across qpdf object renumbering. Both mapping
/// directions are checked so neither a changed reference nor merged aliases can
/// hide a modification. Stream data is generalized-decoded by the pinned engine.
fn compare_graphs(
    left: &Value,
    right: &Value,
    changes: &Changes,
    page_pairs: Option<&[(String, String)]>,
    token: &AtomicBool,
) -> Result<(usize, usize)> {
    let (objects, streams, _) =
        compare_graphs_with_images(left, right, changes, page_pairs, token, false)?;
    Ok((objects, streams))
}

fn compare_graphs_with_images(
    left: &Value,
    right: &Value,
    changes: &Changes,
    page_pairs: Option<&[(String, String)]>,
    token: &AtomicBool,
    allow_images: bool,
) -> Result<(usize, usize, usize)> {
    struct Compare<'a> {
        left: &'a ObjectMap,
        right: &'a ObjectMap,
        changes: &'a Changes,
        forward: HashMap<String, String>,
        reverse: HashMap<String, String>,
        nodes: usize,
        streams: usize,
        token: &'a AtomicBool,
        page_only: bool,
        page_refs: HashSet<String>,
        allow_images: bool,
        image_pairs: HashSet<(String, String)>,
    }
    impl Compare<'_> {
        fn value(&mut self, a: &Value, b: &Value, depth: usize) -> Result<()> {
            cancelled(self.token)?;
            self.nodes += 1;
            if self.nodes > 2_000_000 || depth > 512 {
                return Err("PDF preservation comparison exceeded its safe graph limit.".into());
            }
            let ar = a.as_str().filter(|s| is_ref(s));
            let br = b.as_str().filter(|s| is_ref(s));
            if ar.is_some() || br.is_some() {
                let (Some(ar), Some(br)) = (ar, br) else {
                    return Err("PDF preservation failed: reference replaced by a value.".into());
                };
                if self.allow_images {
                    let original = self
                        .left
                        .get(&format!("obj:{ar}"))
                        .ok_or("Missing original object")?;
                    let output = self
                        .right
                        .get(&format!("obj:{br}"))
                        .ok_or("Missing output object")?;
                    if let Some((expected, actual)) = optimization::image_change(original, output)?
                    {
                        if let Some(prior) = self.reverse.get(br) {
                            if prior != ar {
                                return Err(
                                    "Image compression unexpectedly merged distinct objects."
                                        .into(),
                                );
                            }
                        }
                        self.reverse.insert(br.into(), ar.into());
                        // qpdf may clone a shared image for each page. Validate
                        // every clone; all non-image aliases stay strict.
                        if self.image_pairs.insert((ar.into(), br.into())) {
                            self.value(&expected, &actual, depth + 1)?;
                        }
                        return Ok(());
                    }
                }
                if let Some(mapped) = self.forward.get(ar) {
                    return if mapped == br {
                        Ok(())
                    } else {
                        Err("PDF preservation failed: a reference changed its target.".into())
                    };
                }
                if self.reverse.contains_key(br) {
                    return Err(
                        "PDF preservation failed: distinct referenced objects were merged.".into(),
                    );
                }
                self.forward.insert(ar.into(), br.into());
                self.reverse.insert(br.into(), ar.into());
                let a = self
                    .left
                    .get(&format!("obj:{ar}"))
                    .ok_or("PDF preservation failed: missing original referenced object")?;
                let b = self
                    .right
                    .get(&format!("obj:{br}"))
                    .ok_or("PDF preservation failed: missing output referenced object")?;
                if a.get("stream").is_some() {
                    self.streams += 1
                }
                if self.changes.contains_key(ar) || self.page_only && self.page_refs.contains(ar) {
                    let mut expected = a.clone();
                    let mut actual = b.clone();
                    let expected_dict = if expected.get("value").is_some() {
                        expected.get_mut("value")
                    } else {
                        expected.pointer_mut("/stream/dict")
                    }
                    .and_then(Value::as_object_mut)
                    .ok_or("PDF preservation failed: changed object is not a dictionary")?;
                    if let Some(rules) = self.changes.get(ar) {
                        for (key, value) in rules {
                            if let Some(value) = value {
                                expected_dict.insert(key.clone(), value.clone());
                            } else {
                                expected_dict.remove(key);
                            }
                        }
                    }
                    if self.page_only && self.page_refs.contains(ar) {
                        expected_dict.remove("/Parent");
                        actual
                            .get_mut("value")
                            .and_then(Value::as_object_mut)
                            .ok_or("Output page is not a dictionary")?
                            .remove("/Parent");
                    }
                    return self.value(&expected, &actual, depth + 1);
                }
                return self.value(a, b, depth + 1);
            }
            match (a, b) {
                (Value::Object(a), Value::Object(b)) => {
                    if a.len() != b.len() || a.keys().ne(b.keys()) { return Err("PDF preservation failed: dictionary entries changed outside the approved page properties.".into()) }
                    for (key, av) in a { self.value(av, &b[key], depth + 1)?; }
                }
                (Value::Array(a), Value::Array(b)) => {
                    if a.len() != b.len() { return Err("PDF preservation failed: array length changed.".into()) }
                    for (a, b) in a.iter().zip(b) { self.value(a, b, depth + 1)?; }
                }
                (Value::Number(a), Value::Number(b)) if a == b || (a.is_f64() != b.is_f64() && a.as_f64().map(|n| n.abs() <= 9_007_199_254_740_991.0).unwrap_or(false) && a.as_f64() == b.as_f64()) => {},
                _ if a != b => return Err("PDF preservation failed: a destination, annotation, tag, metadata value, geometry or decoded content stream changed unexpectedly.".into()),
                _ => {}
            }
            Ok(())
        }
    }
    let mut comparer = Compare {
        left: object_map(left)?,
        right: object_map(right)?,
        changes,
        forward: HashMap::new(),
        reverse: HashMap::new(),
        nodes: 0,
        streams: 0,
        token,
        allow_images,
        image_pairs: HashSet::new(),
        page_only: page_pairs.is_some(),
        page_refs: page_pairs
            .map(|p| p.iter().map(|p| p.0.clone()).collect())
            .unwrap_or_default(),
    };
    if let Some(pairs) = page_pairs {
        for (a, b) in pairs {
            comparer.value(&json!(a), &json!(b), 0)?;
        }
    } else {
        const SERIAL: &[&str] = &[
            "/ID",
            "/Size",
            "/Prev",
            "/XRefStm",
            "/Type",
            "/W",
            "/Index",
            "/Length",
            "/Filter",
            "/DecodeParms",
        ];
        let trailer = |objects: &ObjectMap| -> Result<Value> {
            Ok(Value::Object(
                objects
                    .get("trailer")
                    .and_then(object_dict)
                    .ok_or("Missing PDF trailer")?
                    .iter()
                    .filter(|(k, _)| !SERIAL.contains(&k.as_str()))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            ))
        };
        comparer.value(&trailer(comparer.left)?, &trailer(comparer.right)?, 0)?;
    }
    let changed = comparer.image_pairs.len();
    Ok((
        comparer.forward.len() + changed,
        comparer.streams + changed,
        changed,
    ))
}

fn page_objects(report: &Value) -> Result<Vec<String>> {
    report
        .get("pages")
        .and_then(Value::as_array)
        .ok_or("Missing PDF pages")?
        .iter()
        .map(|p| {
            p.get("object")
                .and_then(Value::as_str)
                .filter(|s| is_ref(s))
                .map(String::from)
                .ok_or_else(|| "Missing PDF page reference".into())
        })
        .collect()
}
fn inherited(report: &Value, reference: &str, key: &str) -> Result<Option<Value>> {
    let mut reference = reference.to_string();
    let mut visited = HashSet::new();
    for _ in 0..64 {
        if !visited.insert(reference.clone()) {
            return Err("Cyclic PDF page inheritance is unsupported.".into());
        }
        let dict = object_map(report)?
            .get(&format!("obj:{reference}"))
            .and_then(object_dict)
            .ok_or("Invalid page inheritance")?;
        if let Some(value) = dict.get(key) {
            return resolve(report, value)
                .cloned()
                .map(Some)
                .ok_or_else(|| "Unresolvable page property".into());
        }
        match dict.get("/Parent").and_then(Value::as_str) {
            Some(parent) => reference = parent.into(),
            None => return Ok(None),
        }
    }
    Err("PDF page inheritance exceeds the safe limit.".into())
}

fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(err)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(err)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn validate_magic(path: &Path, kind: &str) -> Result<()> {
    let mut file = File::open(path).map_err(err)?;
    let mut bytes = [0u8; 8];
    let n = file.read(&mut bytes).map_err(err)?;
    let valid = match kind {
        "png" => n >= 8 && bytes == [137, 80, 78, 71, 13, 10, 26, 10],
        "jpg" | "jpeg" => n >= 3 && bytes[..3] == [255, 216, 255],
        "txt" => {
            let bytes = fs::read(path).map_err(err)?;
            std::str::from_utf8(&bytes).is_ok()
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!(
            "The selected or generated file is not a supported {kind} file."
        ))
    }
}

fn safe_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', ':', '\0'])
        || name.chars().any(char::is_control)
        || name.len() > 180
    {
        return Err(
            "Choose a simple output filename without path separators (maximum 180 bytes).".into(),
        );
    }
    Ok(name.into())
}

fn protect_destination(destination: &Path, sources: &[Source]) -> Result<()> {
    if destination.exists() {
        return Err("That file already exists. Choose a new name; PDF Workbench never overwrites existing files.".into());
    }
    let parent = fs::canonicalize(destination.parent().ok_or("Missing destination folder")?)
        .map_err(|e| format!("The destination folder is unavailable: {e}"))?;
    let final_path = parent.join(destination.file_name().ok_or("Missing output filename")?);
    for source in sources {
        if final_path == PathBuf::from(&source.path) {
            return Err("An original source cannot be overwritten. Choose a new filename.".into());
        }
    }
    Ok(())
}

/// Commit a complete, verified file without replacing existing paths. exFAT on
/// macOS lacks RENAME_EXCL and hard links, so use exclusive creation there.
/// A failed/cancelled fallback removes only the file created by this call.
fn commit_new(
    staged: tempfile::NamedTempFile,
    destination: &Path,
    token: &AtomicBool,
) -> Result<bool> {
    cancelled(token)?;
    match staged.persist_noclobber(destination) {
        Ok(_) => Ok(true),
        Err(failure) => {
            if failure.error.kind() != std::io::ErrorKind::Unsupported
                && ![Some(45), Some(95)].contains(&failure.error.raw_os_error())
            {
                return Err(format!(
                    "Could not commit without overwriting: {}",
                    failure.error
                ));
            }
            let mut staged = failure.file;
            let mut output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(destination)
                .map_err(|e| format!("Could not exclusively create a new output: {e}"))?;
            let result = (|| {
                staged.as_file_mut().seek(SeekFrom::Start(0)).map_err(err)?;
                let mut buffer = [0u8; 256 * 1024];
                loop {
                    cancelled(token)?;
                    let n = staged.as_file_mut().read(&mut buffer).map_err(err)?;
                    if n == 0 {
                        break;
                    }
                    output.write_all(&buffer[..n]).map_err(err)?;
                }
                output.sync_all().map_err(err)?;
                cancelled(token)?;
                if hash_file(destination)? != hash_file(staged.path())? {
                    return Err("Export copy hash verification failed.".into());
                }
                Ok(false)
            })();
            drop(output);
            if result.is_err() {
                let _ = fs::remove_file(destination);
            }
            result
        }
    }
}

#[tauri::command]
async fn pick_sources(
    kind: String,
    job_id: Option<String>,
    state: State<'_, Backend>,
) -> Result<Vec<Source>> {
    let backend = state.inner().clone();
    let job = backend.job(job_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        cancelled(&job.token)?;
        let dialog = rfd::FileDialog::new().set_title("Open files in PDF Workbench");
        let dialog = match kind.as_str() {
            "pdf" => dialog.add_filter("PDF", &["pdf"]),
            "images" => dialog.add_filter("PNG and JPEG", &["png", "jpg", "jpeg"]),
            _ => return Err("Unsupported file type".into()),
        };
        let paths = match dialog.pick_files() {
            Some(paths) => paths,
            None => return Ok(vec![]),
        };
        cancelled(&job.token)?;
        if paths.len() > 100 {
            return Err("Open at most 100 files at a time.".into());
        }
        paths
            .iter()
            .map(|path| {
                let ext = path
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_ascii_lowercase();
                let kind = if kind == "pdf" {
                    "pdf"
                } else if ext == "png" {
                    "png"
                } else {
                    "jpg"
                };
                backend.register(path, None, kind, &job.token)
            })
            .collect()
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn read_chunk(
    id: String,
    offset: u64,
    length: usize,
    state: State<'_, Backend>,
) -> Result<tauri::ipc::Response> {
    let source = state.get(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        if length > MAX_CHUNK || offset > source.bytes {
            return Err("Read is outside the authorized chunk limit.".into());
        }
        let mut file = File::open(&source.path).map_err(err)?;
        if file.metadata().map_err(err)?.len() != source.bytes {
            return Err("Source file changed; reopen it.".into());
        }
        file.seek(SeekFrom::Start(offset)).map_err(err)?;
        let mut bytes = vec![0u8; length.min((source.bytes - offset) as usize)];
        file.read_exact(&mut bytes).map_err(err)?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn assemble(
    pages: Vec<PageRef>,
    job_id: String,
    state: State<'_, Backend>,
) -> Result<Source> {
    let backend = state.inner().clone();
    let job = backend.job(Some(job_id))?;
    tauri::async_runtime::spawn_blocking(move || assemble_impl(&backend, &pages, &job.token))
        .await
        .map_err(err)?
}

fn assemble_impl(backend: &Backend, pages: &[PageRef], token: &AtomicBool) -> Result<Source> {
    cancelled(token)?;
    if pages.is_empty() || pages.len() > MAX_PAGES {
        return Err("An output PDF must have 1–1000 pages.".into());
    }
    let mut sources = HashMap::new();
    for page in pages {
        if !sources.contains_key(&page.source_id) {
            let source = backend.get(&page.source_id)?;
            if source.kind != "pdf" || !source.editable {
                return Err(format!("{} is read-only: {}. Structural editing is blocked to preserve these features.", source.name, source.features.join(", ")));
            }
            backend.verify_source(&source)?;
            sources.insert(page.source_id.clone(), source);
        }
        if page.page == 0 || page.page > sources[&page.source_id].pages || page.rotation % 90 != 0 {
            return Err(
                "Invalid page number or rotation; rotations must be multiples of 90°.".into(),
            );
        }
    }
    let output = backend.temp(".pdf")?;
    let mut args = vec![
        sources[&pages[0].source_id].path.clone(),
        "--keep-files-open=n".into(),
        "--pages".into(),
    ];
    let mut at = 0;
    while at < pages.len() {
        let id = &pages[at].source_id;
        let mut range = vec![];
        while at < pages.len() && &pages[at].source_id == id {
            range.push(pages[at].page.to_string());
            at += 1;
        }
        args.push(sources[id].path.clone());
        args.push(range.join(","));
    }
    args.push("--".into());
    for rotation in [90, 180, 270] {
        let range: Vec<String> = pages
            .iter()
            .enumerate()
            .filter(|(_, p)| p.rotation.rem_euclid(360) == rotation)
            .map(|(i, _)| (i + 1).to_string())
            .collect();
        if !range.is_empty() {
            args.push(format!("--rotate=+{rotation}:{}", range.join(",")));
        }
    }
    args.push(text_path(&output));
    let result = (|| {
        backend.qpdf(&args, token, 1024 * 1024)?;
        backend.qpdf(&["--check".into(), text_path(&output)], token, 1024 * 1024)?;
        let source = backend.register(&output, None, "pdf", token)?;
        if source.pages != pages.len() || !source.editable {
            return Err("Output validation failed: unexpected pages or document features.".into());
        }
        Ok(source)
    })();
    if result.is_err() {
        let _ = fs::remove_file(output);
    }
    result
}

fn prepare_changes(report: &Value, pages: &[PreservePage]) -> Result<Changes> {
    let references = page_objects(report)?;
    if pages.len() != references.len() || pages.is_empty() || pages.len() > MAX_PAGES {
        return Err(
            "Preservation requires every original page once, in its original order.".into(),
        );
    }
    let mut changes = Changes::new();
    for (index, page) in pages.iter().enumerate() {
        if page.page != index + 1 || page.rotation % 90 != 0 {
            return Err(
                "Preservation requires the original page order and rotations in multiples of 90°."
                    .into(),
            );
        }
        let reference = &references[index];
        let original_rotation = inherited(report, reference, "/Rotate")?
            .unwrap_or(json!(0))
            .as_i64()
            .ok_or("Unsupported noninteger page rotation")?;
        if original_rotation % 90 != 0 {
            return Err("Unsupported original page rotation; it must be a multiple of 90°.".into());
        }
        let mut rules = HashMap::new();
        if page.rotation.rem_euclid(360) != 0 {
            rules.insert(
                "/Rotate".into(),
                Some(json!((original_rotation.rem_euclid(360)
                    + i64::from(page.rotation).rem_euclid(360))
                .rem_euclid(360))),
            );
        }
        if let Some(crop) = &page.crop {
            let margins = [crop.left, crop.right, crop.top, crop.bottom];
            if margins
                .iter()
                .any(|n| !n.is_finite() || *n < 0.0 || *n > 14_400.0)
            {
                return Err("Crop margins must be finite nonnegative PDF points.".into());
            }
            let media =
                inherited(report, reference, "/MediaBox")?.ok_or("Missing page MediaBox")?;
            let array = media
                .as_array()
                .filter(|a| a.len() == 4)
                .ok_or("Unsupported MediaBox")?;
            let points: Vec<f64> = array
                .iter()
                .map(|v| {
                    v.as_f64()
                        .filter(|n| n.is_finite() && n.abs() <= 14_400.0)
                        .ok_or("Unsupported MediaBox coordinates")
                })
                .collect::<std::result::Result<_, _>>()?;
            let coordinates = [
                points[0] + crop.left,
                points[1] + crop.bottom,
                points[2] - crop.right,
                points[3] - crop.top,
            ];
            if coordinates[2] - coordinates[0] < 1.0 || coordinates[3] - coordinates[1] < 1.0 {
                return Err("Crop must leave at least one PDF point of width and height.".into());
            }
            // qpdf writes real numbers with limited decimal precision. Refuse a
            // requested box that cannot survive exact expected-value comparison.
            rules.insert("/CropBox".into(), Some(json!(coordinates)));
        }
        if !rules.is_empty() {
            changes.insert(reference.clone(), rules);
        }
    }
    Ok(changes)
}
fn write_patch(
    backend: &Backend,
    report: &Value,
    changes: &Changes,
) -> Result<tempfile::NamedTempFile> {
    let mut objects = ObjectMap::new();
    for (reference, rules) in changes {
        let mut object = object_map(report)?
            .get(&format!("obj:{reference}"))
            .cloned()
            .ok_or("Patch target is missing")?;
        let dict = if object.get("value").is_some() {
            object.get_mut("value")
        } else {
            object.pointer_mut("/stream/dict")
        }
        .and_then(Value::as_object_mut)
        .ok_or("Patch target is not a PDF dictionary")?;
        for (key, value) in rules {
            if let Some(value) = value {
                dict.insert(key.clone(), value.clone());
            } else {
                dict.remove(key);
            }
        }
        // A stream dictionary update without data retains its original bytes.
        if let Some(stream) = object.get_mut("stream").and_then(Value::as_object_mut) {
            stream.remove("data");
            stream.remove("datafile");
        }
        objects.insert(format!("obj:{reference}"), object);
    }
    let mut patch = tempfile::NamedTempFile::new_in(backend.0.home.join("tmp")).map_err(err)?;
    serde_json::to_writer(&mut patch, &json!({"qpdf":[{"jsonversion":2},objects]})).map_err(err)?;
    patch.flush().map_err(err)?;
    Ok(patch)
}
fn preserve_impl(
    backend: &Backend,
    source: Source,
    pages: &[PreservePage],
    token: &AtomicBool,
) -> Result<Source> {
    cancelled(token)?;
    backend.verify_source(&source)?;
    let report = graph_report(backend, Path::new(&source.path), token, false)?;
    if source.kind != "pdf" || !capabilities(&report, &inventory(&report)).0 {
        return Err("This document has features outside the verified preservation boundary. Its original remains unchanged.".into());
    }
    let changes = prepare_changes(&report, pages)?;
    // Update the exact original page dictionaries as one whole-document write.
    // No --pages operation is permitted on this preservation path.
    let patch = write_patch(backend, &report, &changes)?;
    let original = graph_report(backend, Path::new(&source.path), token, true)?;
    let output = backend.temp(".pdf")?;
    let result = (|| {
        backend.qpdf(
            &[
                source.path.clone(),
                format!("--update-from-json={}", text_path(patch.path())),
                text_path(&output),
            ],
            token,
            1024 * 1024,
        )?;
        backend.qpdf(&["--check".into(), text_path(&output)], token, 1024 * 1024)?;
        let transformed = graph_report(backend, &output, token, true)?;
        compare_graphs(&original, &transformed, &changes, None, token)?;
        let mut checked = backend.inspect(&output, None, "pdf", token)?;
        if checked.pages != source.pages
            || checked.features != source.features
            || !checked.preserve_document
        {
            return Err("The transformed document failed its feature inventory check.".into());
        }
        backend.verify_source(&source)?;
        cancelled(token)?;
        checked.name = source.name;
        backend
            .0
            .sources
            .lock()
            .map_err(err)?
            .insert(checked.id.clone(), checked.clone());
        Ok(checked)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&output);
    }
    result
}
#[tauri::command]
async fn preserve_document(
    id: String,
    pages: Vec<PreservePage>,
    job_id: String,
    state: State<'_, Backend>,
) -> Result<Source> {
    let backend = state.inner().clone();
    let job = backend.job(Some(job_id))?;
    tauri::async_runtime::spawn_blocking(move || {
        preserve_impl(&backend, backend.get(&id)?, &pages, &job.token)
    })
    .await
    .map_err(err)?
}
fn editing_copy_impl(backend: &Backend, source: Source, token: &AtomicBool) -> Result<Source> {
    cancelled(token)?;
    backend.verify_source(&source)?;
    let report = graph_report(backend, Path::new(&source.path), token, false)?;
    if source.kind != "pdf" || !capabilities(&report, &inventory(&report)).1 {
        return Err("An editing copy is unavailable: unsupported document features or potentially visible annotation appearances cannot be removed safely.".into());
    }
    let page_refs = page_objects(&report)?;
    let mut changes = Changes::new();
    for (key, object) in object_map(&report)? {
        let Some(dict) = object_dict(object) else {
            continue;
        };
        let Some(reference) = key.strip_prefix("obj:") else {
            continue;
        };
        let mut rules = HashMap::new();
        for property in ["/Metadata", "/StructParent", "/StructParents", "/Tabs"] {
            if dict.contains_key(property) {
                rules.insert(property.into(), None);
            }
        }
        if page_refs.iter().any(|p| p == reference) && dict.contains_key("/Annots") {
            rules.insert("/Annots".into(), None);
        }
        if !rules.is_empty() {
            changes.insert(reference.into(), rules);
        }
    }
    let patch = write_patch(backend, &report, &changes)?;
    let sanitized = backend.temp(".pdf")?;
    let output = backend.temp(".pdf")?;
    let result = (|| {
        let original = graph_report(backend, Path::new(&source.path), token, true)?;
        backend.qpdf(
            &[
                source.path.clone(),
                format!("--update-from-json={}", text_path(patch.path())),
                text_path(&sanitized),
            ],
            token,
            1024 * 1024,
        )?;
        backend.qpdf(
            &[
                "--empty".into(),
                "--pages".into(),
                text_path(&sanitized),
                "1-z".into(),
                "--".into(),
                "--remove-page-labels".into(),
                text_path(&output),
            ],
            token,
            1024 * 1024,
        )?;
        backend.qpdf(&["--check".into(), text_path(&output)], token, 1024 * 1024)?;
        let result_report = graph_report(backend, &output, token, false)?;
        let result_refs = page_objects(&result_report)?;
        if result_refs.len() != page_refs.len() {
            return Err("Editing copy changed the number of pages.".into());
        }
        let pairs: Vec<_> = page_refs.iter().cloned().zip(result_refs).collect();
        // qpdf may flatten inherited page geometry during a page-only copy.
        // Establish the original effective geometry as the required output value.
        for (original_ref, output_ref) in &pairs {
            let out_dict = object_map(&result_report)?
                .get(&format!("obj:{output_ref}"))
                .and_then(object_dict)
                .ok_or("Missing editing-copy page")?;
            for key in ["/MediaBox", "/CropBox", "/Rotate", "/Resources"] {
                let original_value = inherited(&report, original_ref, key)?;
                let output_value = inherited(&result_report, output_ref, key)?;
                if key != "/Resources" && original_value != output_value {
                    return Err("Editing copy changed effective page geometry.".into());
                }
                if !object_map(&report)?
                    .get(&format!("obj:{original_ref}"))
                    .and_then(object_dict)
                    .unwrap()
                    .contains_key(key)
                    && out_dict.contains_key(key)
                {
                    if let Some(value) = original_value {
                        changes
                            .entry(original_ref.clone())
                            .or_default()
                            .insert(key.into(), Some(value));
                    }
                }
            }
        }
        let transformed = graph_report(backend, &output, token, true)?;
        compare_graphs(&original, &transformed, &changes, Some(&pairs), token)?;
        let mut checked = backend.inspect(&output, None, "pdf", token)?;
        if !checked.editable || checked.pages != source.pages {
            return Err(format!(
                "Editing copy still contains unsupported structures: {}",
                checked.features.join(", ")
            ));
        }
        checked.removed_features = source.features.clone();
        if object_map(&report)?
            .get("trailer")
            .and_then(object_dict)
            .map(|d| d.contains_key("/Info"))
            .unwrap_or(false)
        {
            checked
                .removed_features
                .push("document information metadata".into());
        }
        for object in object_map(&report)?.values() {
            if let Some(catalog) = object_dict(object)
                .filter(|d| d.get("/Type").and_then(Value::as_str) == Some("/Catalog"))
            {
                if ["/ViewerPreferences", "/PageMode", "/PageLayout"]
                    .iter()
                    .any(|k| catalog.contains_key(*k))
                {
                    checked
                        .removed_features
                        .push("document viewing preferences".into());
                }
                if catalog.contains_key("/Lang") {
                    checked
                        .removed_features
                        .push("document language metadata".into());
                }
            }
        }
        checked.name = format!(
            "{} — editing copy.pdf",
            source.name.strip_suffix(".pdf").unwrap_or(&source.name)
        );
        backend.verify_source(&source)?;
        cancelled(token)?;
        backend
            .0
            .sources
            .lock()
            .map_err(err)?
            .insert(checked.id.clone(), checked.clone());
        Ok(checked)
    })();
    let _ = fs::remove_file(sanitized);
    if result.is_err() {
        let _ = fs::remove_file(output);
    }
    result
}
#[tauri::command]
async fn create_editing_copy(
    id: String,
    job_id: String,
    state: State<'_, Backend>,
) -> Result<Source> {
    let backend = state.inner().clone();
    let job = backend.job(Some(job_id))?;
    tauri::async_runtime::spawn_blocking(move || {
        editing_copy_impl(&backend, backend.get(&id)?, &job.token)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn begin_stage(name: String, kind: String, state: State<'_, Backend>) -> Result<String> {
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let name = safe_name(&name)?;
        if !["pdf", "png", "jpg", "txt"].contains(&kind.as_str()) {
            return Err("Unsupported staged output format".into());
        }
        let mut stages = backend.0.stages.lock().map_err(err)?;
        if stages.len() >= 16 {
            return Err(
                "Too many unfinished staged files. Restart the app to clear abandoned jobs.".into(),
            );
        }
        let id = new_id();
        let path = backend.temp(&format!(".{kind}"))?;
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(err)?;
        stages.insert(
            id.clone(),
            Stage {
                path,
                name,
                kind,
                size: 0,
            },
        );
        Ok(id)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn write_chunk(
    id: String,
    offset: u64,
    data: Vec<u8>,
    state: State<'_, Backend>,
) -> Result<()> {
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        backend.ensure_home()?;
        if data.len() > MAX_CHUNK {
            return Err("Write exceeds 256 KiB chunk limit.".into());
        }
        let mut stages = backend.0.stages.lock().map_err(err)?;
        let stage = stages
            .get_mut(&id)
            .ok_or("Unknown or finalized staging file")?;
        if offset != stage.size || offset + data.len() as u64 > MAX_BYTES {
            return Err("Invalid stage offset or output exceeds 50 MiB limit.".into());
        }
        let mut file = OpenOptions::new()
            .append(true)
            .open(&stage.path)
            .map_err(err)?;
        file.write_all(&data).map_err(err)?;
        stage.size += data.len() as u64;
        Ok(())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn finish_stage(
    id: String,
    job_id: Option<String>,
    state: State<'_, Backend>,
) -> Result<Source> {
    let backend = state.inner().clone();
    let job = backend.job(job_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let stage = backend
            .0
            .stages
            .lock()
            .map_err(err)?
            .remove(&id)
            .ok_or("Unknown or finalized staging file")?;
        let result = (|| {
            if stage.kind == "pdf" {
                backend.qpdf(
                    &["--check".into(), text_path(&stage.path)],
                    &job.token,
                    1024 * 1024,
                )?;
            }
            let mut source = backend.register(&stage.path, Some(id), &stage.kind, &job.token)?;
            source.name = stage.name;
            backend
                .0
                .sources
                .lock()
                .map_err(err)?
                .insert(source.id.clone(), source.clone());
            Ok(source)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&stage.path);
        }
        result
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn discard_stage(id: String, state: State<'_, Backend>) -> Result<()> {
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(stage) = backend.0.stages.lock().map_err(err)?.remove(&id) {
            fs::remove_file(stage.path).map_err(err)?;
        }
        Ok(())
    })
    .await
    .map_err(err)?
}

fn export_to(
    backend: &Backend,
    source: Source,
    destination: PathBuf,
    optimization: Option<Optimization>,
    recipe: Option<Value>,
    token: &AtomicBool,
) -> Result<ExportReport> {
    let started = Instant::now();
    backend.ensure_home()?;
    backend.verify_source(&source)?;
    let all: Vec<Source> = backend
        .0
        .sources
        .lock()
        .map_err(err)?
        .values()
        .cloned()
        .collect();
    protect_destination(&destination, &all)?;
    let receipt_path = PathBuf::from(format!("{}.recipe.json", text_path(&destination)));
    if recipe.is_some() {
        protect_destination(&receipt_path, &all)?;
    }
    if optimization.is_some() && (source.kind != "pdf" || !source.preserve_document) {
        return Err("Optimization is available only for PDFs within the verified document-preservation boundary.".into());
    }
    // Stage next to the final file, then use persist_noclobber. This never replaces
    // an existing path even if another program creates it after the picker closes.
    let parent = destination.parent().ok_or("Missing output folder")?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("Cannot create output in that folder: {e}"))?;
    if let Some(preset) = optimization {
        let mut args = vec![source.path.clone()];
        args.extend(preset.args());
        args.push(text_path(staged.path()));
        backend.qpdf(&args, token, 1024 * 1024)?;
    } else {
        let mut input = File::open(&source.path).map_err(err)?;
        let mut buffer = [0u8; 256 * 1024];
        loop {
            cancelled(token)?;
            let n = input.read(&mut buffer).map_err(err)?;
            if n == 0 {
                break;
            }
            staged.write_all(&buffer[..n]).map_err(err)?;
        }
    }
    staged.as_file().sync_all().map_err(err)?;
    cancelled(token)?;
    let mut validation = vec![
        "Original source SHA-256 unchanged".into(),
        "Export committed without overwriting an existing file".into(),
    ];
    let mut changed_images = 0;
    if source.kind == "pdf" {
        backend.qpdf(
            &["--check".into(), text_path(staged.path())],
            token,
            1024 * 1024,
        )?;
        let checked = backend.register(staged.path(), None, "pdf", token)?;
        backend.0.sources.lock().map_err(err)?.remove(&checked.id);
        if checked.pages != source.pages || checked.features != source.features {
            return Err("Output validation found changed page count or document feature inventory. Export was not committed.".into());
        }
        if let Some(preset) = optimization {
            let original_graph = graph_report(backend, Path::new(&source.path), token, true)?;
            let output_graph = graph_report(backend, staged.path(), token, true)?;
            let (objects, streams, images) = compare_graphs_with_images(
                &original_graph,
                &output_graph,
                &Changes::new(),
                None,
                token,
                preset.quality().is_some(),
            )?;
            changed_images = images;
            validation.push(format!("Verified {objects} reachable objects and {streams} streams; {images} image objects recompressed. Text, vectors, metadata, destinations, links and tags preserved within the supported boundary"));
            if let Some(quality) = preset.quality() {
                validation.push(format!("Lossy image preset: JPEG quality {quality}; original pixel dimensions retained. Review fine detail in the exported copy"));
                if images == 0 {
                    validation.push("No eligible images became smaller; only structural compression was applied".into());
                }
            }
        }
        validation
            .push("qpdf structural check, page count and document feature inventory passed".into());
        validation.push("Visual fidelity and universal PDF conformance are not asserted by this structural check".into());
    } else {
        validate_magic(staged.path(), &source.kind)?;
        validation.push("Output file signature/encoding checked".into());
    }
    let output_hash = hash_file(staged.path())?;
    let output_bytes = staged.as_file().metadata().map_err(err)?.len();
    let mut receipt_stage = if let Some(recipe) = recipe {
        let receipt = json!({"schemaVersion":1,"appVersion":env!("CARGO_PKG_VERSION"),"operation":recipe,"optimization":optimization.map(|p| p.settings(changed_images)),"input":{"sha256":source.sha256,"bytes":source.bytes},"output":{"sha256":output_hash,"bytes":output_bytes},"validation":validation});
        let data = serde_json::to_vec_pretty(&receipt).map_err(err)?;
        if data.len() as u64 > MAX_PROJECT {
            return Err("Operation receipt exceeds 8 MiB.".into());
        }
        let mut receipt_stage = tempfile::NamedTempFile::new_in(parent).map_err(err)?;
        receipt_stage.write_all(&data).map_err(err)?;
        receipt_stage.as_file().sync_all().map_err(err)?;
        Some(receipt_stage)
    } else {
        None
    };
    backend.verify_source(&source)?;
    cancelled(token)?;
    let atomic = commit_new(staged, &destination, token)?;
    if !atomic {
        validation.push("This filesystem does not support an atomic no-clobber commit; a verified exclusive-create copy was used".into());
    }
    if let Some(receipt) = receipt_stage.take() {
        if let Err(e) = commit_new(receipt, &receipt_path, &AtomicBool::new(false)) {
            // The PDF is a valid export even if a racing writer takes receipt name.
            validation.push(format!(
                "PDF saved; recipe receipt could not be committed: {e}"
            ));
        }
    }
    // Registration uses data already validated prior to atomic commit, and hashes
    // the actual output again. A post-commit read failure reports its exact path.
    let reopened = backend
        .register(&destination, None, &source.kind, &AtomicBool::new(false))
        .map_err(|e| {
            format!(
                "Export saved at {}, but reopening failed: {e}",
                text_path(&destination)
            )
        })?;
    Ok(ExportReport {
        path: text_path(&destination),
        bytes: reopened.bytes,
        input_bytes: source.bytes,
        sha256: reopened.sha256.clone(),
        elapsed_ms: started.elapsed().as_millis(),
        validation,
        source: reopened,
        optimization: optimization.map(|p| p.settings(changed_images)),
    })
}

#[tauri::command]
async fn export_file(
    id: String,
    suggested_name: String,
    optimization: Option<Optimization>,
    recipe: Option<Value>,
    job_id: Option<String>,
    state: State<'_, Backend>,
) -> Result<Option<ExportReport>> {
    let backend = state.inner().clone();
    let job = backend.job(job_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let source = backend.get(&id)?;
        let name = safe_name(&suggested_name)?;
        let destination = rfd::FileDialog::new()
            .set_title("Export a new copy — existing files are never replaced")
            .set_file_name(name)
            .add_filter(source.kind.to_uppercase(), &[&source.kind])
            .save_file();
        let Some(destination) = destination else {
            return Ok(None);
        };
        cancelled(&job.token)?;
        export_to(
            &backend,
            source,
            destination,
            optimization,
            recipe,
            &job.token,
        )
        .map(Some)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn export_batch(
    items: Vec<BatchItem>,
    recipe: Option<Value>,
    job_id: Option<String>,
    state: State<'_, Backend>,
) -> Result<Option<Vec<ExportReport>>> {
    let backend = state.inner().clone();
    let job = backend.job(job_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        if items.is_empty() || items.len() > MAX_PAGES { return Err("A batch must contain 1–1000 files.".into()); }
        let Some(directory) = rfd::FileDialog::new().set_title("Choose a folder for new export copies").pick_folder() else { return Ok(None); };
        cancelled(&job.token)?;
        let mut names = HashSet::new(); let mut prepared = vec![];
        let all: Vec<Source> = backend.0.sources.lock().map_err(err)?.values().cloned().collect();
        for item in items {
            let name = safe_name(&item.name)?;
            if !names.insert(name.to_lowercase()) { return Err("Batch output filenames must be unique (ignoring case).".into()); }
            let destination = directory.join(&name); protect_destination(&destination, &all)?;
            if recipe.is_some() { protect_destination(&directory.join(format!("{name}.recipe.json")), &all)?; }
            prepared.push((backend.get(&item.id)?, destination));
        }
        let mut reports = vec![];
        for (source, destination) in prepared {
            match export_to(&backend, source, destination, None, recipe.clone(), &job.token) {
                Ok(report) => reports.push(report),
                Err(e) => return Err(format!("Batch stopped after {} successfully saved file(s). Completed outputs remain in {}: {}. {e}", reports.len(), text_path(&directory), reports.iter().map(|r: &ExportReport| r.path.as_str()).collect::<Vec<_>>().join("; "))),
            }
        }
        Ok(Some(reports))
    }).await.map_err(err)?
}

#[tauri::command]
fn cancel_job(job_id: String, state: State<'_, Backend>) -> Result<()> {
    if let Some(token) = state.0.jobs.lock().map_err(err)?.get(&job_id) {
        token.store(true, Ordering::SeqCst);
    }
    Ok(())
}

fn validate_project(project: &Value) -> Result<&Vec<Value>> {
    if project.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("Unsupported project schema. This release opens schemaVersion 1; no automatic migration was attempted.".into());
    }
    if let Some(settings) = project.get("optimization") {
        if settings.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
            return Err("Unsupported optimization settings version.".into());
        }
        serde_json::from_value::<Optimization>(
            settings.get("preset").cloned().unwrap_or(Value::Null),
        )
        .map_err(|_| "Unknown optimization preset")?;
    }
    let sources = project
        .get("sources")
        .and_then(Value::as_array)
        .ok_or("Project sources must be an array")?;
    if sources.len() > 2000 {
        return Err("Project source count exceeds the safe limit.".into());
    }
    let mut ids = HashSet::new();
    for source in sources {
        let id = source
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Project source is missing its id")?;
        if !ids.insert(id) {
            return Err("Project has duplicate source IDs.".into());
        }
        if source.get("path").and_then(Value::as_str).is_none()
            || source.get("sha256").and_then(Value::as_str).map(str::len) != Some(64)
        {
            return Err("Project source is missing its path or SHA-256 fingerprint.".into());
        }
        if !["pdf", "png", "jpg", "jpeg"]
            .contains(&source.get("kind").and_then(Value::as_str).unwrap_or("pdf"))
        {
            return Err("Project inputs must be PDFs, PNGs, or JPEGs.".into());
        }
    }
    if project.get("name").and_then(Value::as_str).is_none() {
        return Err("Project name is missing.".into());
    }
    validate_project_pages(project.get("pages"), &ids, false)?;
    for key in ["history", "future"] {
        let history = project
            .get(key)
            .and_then(Value::as_array)
            .ok_or("Project undo/redo history is missing")?;
        if history.len() > 100 {
            return Err("Project undo/redo history exceeds 100 snapshots.".into());
        }
        for snapshot in history {
            validate_project_pages(snapshot.get("pages"), &ids, true)?;
        }
    }
    Ok(sources)
}

fn validate_project_pages(
    value: Option<&Value>,
    sources: &HashSet<&str>,
    allow_empty: bool,
) -> Result<()> {
    let pages = value
        .and_then(Value::as_array)
        .ok_or("Project pages must be an array")?;
    if (!allow_empty && pages.is_empty()) || pages.len() > MAX_PAGES {
        return Err("Saved projects must contain 1–1000 pages.".into());
    }
    let mut ids = HashSet::new();
    for page in pages {
        let id = page
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Page identity is missing")?;
        if !ids.insert(id) {
            return Err("Page identities must be unique within each snapshot.".into());
        }
        if let Some(source_id) = page.get("sourceId").and_then(Value::as_str) {
            if !sources.contains(source_id)
                || page
                    .get("page")
                    .and_then(Value::as_u64)
                    .map(|n| n == 0 || n > MAX_PAGES as u64)
                    .unwrap_or(true)
            {
                return Err("Project page references an invalid source or page number.".into());
            }
        } else {
            let blank = page
                .get("blank")
                .ok_or("Page needs a source or blank paper dimensions")?;
            for dimension in ["width", "height"] {
                if blank
                    .get(dimension)
                    .and_then(Value::as_f64)
                    .map(|n| !(12.0..=14400.0).contains(&n))
                    .unwrap_or(true)
                {
                    return Err("Blank paper dimensions must be 12–14,400 points.".into());
                }
            }
        }
        if page
            .get("rotation")
            .and_then(Value::as_i64)
            .map(|n| n % 90 != 0 || n.unsigned_abs() > 360000)
            .unwrap_or(true)
        {
            return Err("Project rotation must be a bounded multiple of 90°.".into());
        }
        if let Some(crop) = page.get("crop") {
            for edge in ["left", "right", "bottom", "top"] {
                if crop
                    .get(edge)
                    .and_then(Value::as_f64)
                    .map(|n| !(0.0..=14400.0).contains(&n))
                    .unwrap_or(true)
                {
                    return Err(
                        "Project crop margins must be valid nonnegative point values.".into(),
                    );
                }
            }
        }
        if let Some(resize) = page.get("resize") {
            let width = resize.get("width").and_then(Value::as_f64).unwrap_or(0.0);
            let height = resize.get("height").and_then(Value::as_f64).unwrap_or(0.0);
            let margin = resize.get("margin").and_then(Value::as_f64).unwrap_or(-1.0);
            if !(12.0..=14400.0).contains(&width)
                || !(12.0..=14400.0).contains(&height)
                || margin < 0.0
                || margin * 2.0 >= width.min(height)
                || !["bounds", "fit", "stretch"].contains(&resize["mode"].as_str().unwrap_or(""))
                || !["center", "bottom-left"].contains(&resize["anchor"].as_str().unwrap_or(""))
            {
                return Err("Project contains invalid resize settings.".into());
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn save_project(
    mut project: Value,
    job_id: Option<String>,
    state: State<'_, Backend>,
) -> Result<Option<String>> {
    let backend = state.inner().clone();
    let job = backend.job(job_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        cancelled(&job.token)?;
        backend.ensure_home()?;
        let sources = validate_project(&project)?;
        for value in sources {
            cancelled(&job.token)?;
            let source = backend.get(value["id"].as_str().unwrap())?;
            if value["path"].as_str() != Some(source.path.as_str()) || value["sha256"].as_str() != Some(source.sha256.as_str()) { return Err("Project source information does not match the authorized file.".into()); }
            backend.verify_source(&source)?;
        }
        cancelled(&job.token)?;
        let Some(path) = rfd::FileDialog::new().set_title("Save project as a new file").set_file_name("Untitled.pdfworkbench.json").add_filter("PDF Workbench project", &["json"]).save_file() else { return Ok(None); };
        cancelled(&job.token)?;
        let all: Vec<Source> = backend.0.sources.lock().map_err(err)?.values().cloned().collect(); protect_destination(&path, &all)?;
        // Generated/assembled image inputs must survive restart independently of
        // temporary job files. Source IDs stay stable; only saved paths change.
        let assets = backend.0.home.join("projects").join("assets");
        fs::create_dir_all(&assets).map_err(err)?;
        for value in project.get_mut("sources").and_then(Value::as_array_mut).unwrap() {
            cancelled(&job.token)?;
            let source = backend.get(value["id"].as_str().unwrap())?;
            if Path::new(&source.path).starts_with(backend.0.home.join("tmp")) {
                let asset = assets.join(format!("{}.{}", source.sha256, source.kind));
                if asset.exists() {
                    if hash_file(&asset)? != source.sha256 { return Err("A stored project asset changed. The existing asset was not overwritten.".into()); }
                } else {
                    let mut copy = tempfile::NamedTempFile::new_in(&assets).map_err(err)?;
                    let mut input = File::open(&source.path).map_err(err)?;
                    std::io::copy(&mut input, &mut copy).map_err(err)?; copy.as_file().sync_all().map_err(err)?;
                    if hash_file(copy.path())? != source.sha256 { return Err("Project asset verification failed.".into()); }
                    commit_new(copy, &asset, &job.token)?;
                }
                value["path"] = json!(text_path(&asset));
            }
        }
        cancelled(&job.token)?;
        let data = serde_json::to_vec_pretty(&project).map_err(err)?;
        if data.len() as u64 > MAX_PROJECT { return Err("Project exceeds 8 MiB safety limit.".into()); }
        let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Missing project folder")?).map_err(err)?;
        file.write_all(&data).map_err(err)?; file.as_file().sync_all().map_err(err)?;
        commit_new(file, &path, &job.token)?;
        Ok(Some(text_path(&path)))
    }).await.map_err(err)?
}

fn restore_sources(backend: &Backend, project: &Value, token: &AtomicBool) -> Result<Vec<Source>> {
    cancelled(token)?;
    let source_values = validate_project(project)?;
    let mut sources = vec![];
    for value in source_values {
        cancelled(token)?;
        let source_path = PathBuf::from(value["path"].as_str().unwrap());
        if !source_path.is_absolute() {
            return Err("Project source paths must be absolute.".into());
        }
        let kind = value.get("kind").and_then(Value::as_str).unwrap_or("pdf");
        let mut source = backend.inspect(
            &source_path,
            Some(value["id"].as_str().unwrap().into()),
            kind,
            token,
        )?;
        if source.sha256 != value["sha256"].as_str().unwrap() {
            return Err(format!("Project input {} has changed. Its SHA-256 fingerprint does not match; project loading stopped.", source.name));
        }
        if let Some(name) = value.get("name").and_then(Value::as_str) {
            source.name = safe_name(name)?;
        }
        sources.push(source);
    }
    // Commit the admitted sources together. A cancelled or failed restoration
    // must leave the currently open project's source IDs untouched.
    cancelled(token)?;
    let mut registered = backend.0.sources.lock().map_err(err)?;
    for source in &sources {
        if let Some(previous) = registered.get(&source.id) {
            if previous.sha256 != source.sha256 || previous.kind != source.kind {
                return Err("A project source identity already belongs to different content in this session. Reopen PDF Workbench before opening that project.".into());
            }
        }
    }
    for source in &sources {
        registered.insert(source.id.clone(), source.clone());
    }
    Ok(sources)
}

#[tauri::command]
async fn restore_project(
    project: Value,
    job_id: Option<String>,
    state: State<'_, Backend>,
) -> Result<Value> {
    let backend = state.inner().clone();
    let job = backend.job(job_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        cancelled(&job.token)?;
        if serde_json::to_vec(&project).map_err(err)?.len() as u64 > MAX_PROJECT {
            return Err("Recovery project exceeds 8 MiB safety limit.".into());
        }
        let sources = restore_sources(&backend, &project, &job.token)?;
        Ok(json!({"project":project,"sources":sources}))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn open_project(job_id: Option<String>, state: State<'_, Backend>) -> Result<Option<Value>> {
    let backend = state.inner().clone();
    let job = backend.job(job_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        cancelled(&job.token)?;
        let Some(path) = rfd::FileDialog::new()
            .set_title("Open PDF Workbench project and its referenced sources")
            .add_filter("PDF Workbench project", &["json"])
            .pick_file()
        else {
            return Ok(None);
        };
        cancelled(&job.token)?;
        if fs::metadata(&path).map_err(err)?.len() > MAX_PROJECT {
            return Err("Project exceeds 8 MiB safety limit.".into());
        }
        let project: Value = serde_json::from_slice(&fs::read(&path).map_err(err)?).map_err(err)?;
        let sources = restore_sources(&backend, &project, &job.token)?;
        Ok(Some(
            json!({"path":text_path(&path),"project":project,"sources":sources}),
        ))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn engine_info(state: State<'_, Backend>) -> Result<Value> {
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = backend.qpdf(&["--version".into()], &AtomicBool::new(false), 4096)?;
        Ok(json!({"appVersion":env!("CARGO_PKG_VERSION"),"qpdf":String::from_utf8_lossy(&bytes).trim(),"enginePath":text_path(&backend.0.engine),"workspace":text_path(&backend.0.home),"maxInputBytes":MAX_BYTES,"maxPages":MAX_PAGES,"chunkBytes":MAX_CHUNK,"nativeJobConcurrency":1,"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH}))
    }).await.map_err(err)?
}

#[tauri::command]
async fn record_metric(name: String, duration_ms: f64, state: State<'_, Backend>) -> Result<()> {
    let backend = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !["first-page-ms", "frontend-ready-ms", "thumbnail-ms"].contains(&name.as_str())
            || !duration_ms.is_finite() || !(0.0..=600000.0).contains(&duration_ms) {
            return Err("Unsupported performance metric.".into());
        }
        let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_millis();
        let metric = json!({"name":name,"durationMs":duration_ms,"timestampMs":timestamp,"architecture":std::env::consts::ARCH,"appVersion":env!("CARGO_PKG_VERSION")});
        {
            let mut metrics = backend.0.metrics.lock().map_err(err)?;
            if metrics.len() >= 256 { metrics.remove(0); }
            metrics.push(metric.clone());
        }
        // Ordinary launch never touches the external workspace. Explicit local
        // benchmark runs opt into filesystem recording via their launcher env.
        if std::env::var("PDFWORKBENCH_BENCHMARK").as_deref() != Ok("1") { return Ok(()); }
        backend.ensure_home()?;
        let path = backend.0.home.join("tmp").join("metrics.jsonl");
        if path.metadata().map(|m| m.len() > 1024 * 1024).unwrap_or(false) { return Ok(()); }
        let mut line = serde_json::to_vec(&metric).map_err(err)?; line.push(b'\n');
        OpenOptions::new().create(true).append(true).open(path).map_err(err)?.write_all(&line).map_err(err)
    }).await.map_err(err)?
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let configured_home = std::env::var_os("PDFWORKBENCH_HOME");
            let initialize_home = configured_home.is_none();
            let home = match configured_home {
                Some(path) => {
                    let path = PathBuf::from(path);
                    if !path.is_absolute() {
                        return Err("PDFWORKBENCH_HOME must be an absolute workspace path".into());
                    }
                    path
                }
                None => app.path().app_local_data_dir()?.join("Workspace"),
            };
            let engine_name = if cfg!(target_os = "windows") {
                "qpdf.exe"
            } else {
                "qpdf"
            };
            let engine = if cfg!(debug_assertions) {
                let target = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                    "aarch64-apple-darwin"
                } else if cfg!(target_os = "windows") {
                    "x86_64-pc-windows-msvc"
                } else {
                    "unsupported"
                };
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("binaries")
                    .join(format!(
                        "qpdf-{target}{}",
                        if cfg!(target_os = "windows") {
                            ".exe"
                        } else {
                            ""
                        }
                    ))
            } else {
                std::env::current_exe()?
                    .parent()
                    .ok_or("Missing app executable directory")?
                    .join(engine_name)
            };
            app.manage(Backend(Arc::new(Inner {
                home,
                initialize_home,
                engine,
                sources: Mutex::new(HashMap::new()),
                stages: Mutex::new(HashMap::new()),
                jobs: Mutex::new(HashMap::new()),
                busy: AtomicBool::new(false),
                metrics: Mutex::new(Vec::new()),
            })));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_sources,
            read_chunk,
            assemble,
            preserve_document,
            create_editing_copy,
            begin_stage,
            write_chunk,
            finish_stage,
            discard_stage,
            export_file,
            export_batch,
            cancel_job,
            save_project,
            open_project,
            restore_project,
            engine_info,
            record_metric
        ])
        .run(tauri::generate_context!())
        .expect("PDF Workbench could not start");
}

#[cfg(test)]
mod tests {
    use super::*;
    fn graph_fixture() -> Value {
        json!({"pages":[{"object":"3 0 R"}],"qpdf":[{}, {
            "trailer":{"value":{"/Root":"1 0 R","/Info":"2 0 R","/Size":9}},
            "obj:1 0 R":{"value":{"/Type":"/Catalog","/Pages":"4 0 R","/OpenAction":["3 0 R","/Fit"],"/Names":{"/Dests":{"/Names":["u:start",["3 0 R","/Fit"]]}},"/StructTreeRoot":"7 0 R"}},
            "obj:2 0 R":{"value":{"/Title":"u:Original title"}},
            "obj:3 0 R":{"value":{"/Type":"/Page","/Parent":"4 0 R","/MediaBox":[0,0,600,800],"/Annots":["5 0 R"],"/Contents":"6 0 R"}},
            "obj:4 0 R":{"value":{"/Type":"/Pages","/Kids":["3 0 R"],"/Count":1}},
            "obj:5 0 R":{"value":{"/Type":"/Annot","/Subtype":"/Link","/BS":{"/W":0},"/A":{"/S":"/URI","/URI":"u:https://example.com"},"/P":"3 0 R"}},
            "obj:6 0 R":{"stream":{"dict":{},"data":"QUJD"}},
            "obj:7 0 R":{"value":{"/Type":"/StructTreeRoot","/K":{"/Type":"/StructElem","/S":"/P","/Pg":"3 0 R"}}}
        }]})
    }
    #[test]
    fn preservation_detects_semantic_damage_with_unchanged_feature_inventory() {
        let original = graph_fixture();
        let token = AtomicBool::new(false);
        assert!(compare_graphs(&original, &original, &Changes::new(), None, &token).is_ok());
        for (pointer, replacement) in [
            (
                "/qpdf/1/obj:5 0 R/value/~1A/~1URI",
                json!("u:https://changed.example"),
            ),
            (
                "/qpdf/1/obj:1 0 R/value/~1Names/~1Dests/~1Names/0",
                json!("u:changed"),
            ),
            ("/qpdf/1/obj:7 0 R/value/~1K/~1S", json!("/H1")),
            ("/qpdf/1/obj:6 0 R/stream/data", json!("REVG")),
            ("/qpdf/1/obj:2 0 R/value/~1Title", json!("u:Changed title")),
        ] {
            let mut damaged = original.clone();
            *damaged.pointer_mut(pointer).unwrap() = replacement;
            assert_eq!(inventory(&original), inventory(&damaged));
            assert!(
                compare_graphs(&original, &damaged, &Changes::new(), None, &token).is_err(),
                "{pointer}"
            );
        }
        assert!(compare_graphs(
            &original,
            &original,
            &Changes::new(),
            None,
            &AtomicBool::new(true)
        )
        .is_err());
    }
    #[test]
    fn approved_geometry_requires_exact_expected_values_and_complete_order() {
        let original = graph_fixture();
        let token = AtomicBool::new(false);
        let pages = vec![PreservePage {
            page: 1,
            rotation: 90,
            crop: Some(CropMargins {
                left: 10.0,
                right: 20.0,
                top: 30.0,
                bottom: 40.0,
            }),
        }];
        let changes = prepare_changes(&original, &pages).unwrap();
        let mut output = original.clone();
        output["qpdf"][1]["obj:3 0 R"]["value"]["/Rotate"] = json!(90);
        output["qpdf"][1]["obj:3 0 R"]["value"]["/CropBox"] = json!([10, 40, 580, 770]);
        assert!(compare_graphs(&original, &output, &changes, None, &token).is_ok());
        output["qpdf"][1]["obj:3 0 R"]["value"]["/Rotate"] = json!(180);
        assert!(compare_graphs(&original, &output, &changes, None, &token).is_err());
        assert!(prepare_changes(&original, &[]).is_err());
        assert!(prepare_changes(
            &original,
            &[PreservePage {
                page: 2,
                rotation: 0,
                crop: None
            }]
        )
        .is_err());
    }
    #[test]
    fn navigation_is_passive_but_visible_annotations_and_active_features_block_copy() {
        let mut report = graph_fixture();
        assert_eq!(capabilities(&report, &inventory(&report)), (true, true));
        assert!(inventory(&report).contains(&"document opening view".into()));
        assert!(!inventory(&report).contains(&"JavaScript actions".into()));
        report["qpdf"][1]["obj:5 0 R"]["value"]["/BS"]["/W"] = json!(1);
        assert_eq!(capabilities(&report, &inventory(&report)), (true, false));
        report["qpdf"][1]["obj:5 0 R"]["value"]["/AP"] = json!({});
        assert!(!capabilities(&report, &inventory(&report)).1);
        report["qpdf"][1]["obj:5 0 R"]["value"]["/A"] =
            json!({"/S":"/JavaScript","/JS":"u:alert(1)"});
        assert_eq!(capabilities(&report, &inventory(&report)), (false, false));
    }
    #[test]
    fn preservation_rejects_reference_alias_changes_and_accepts_renumbering() {
        let original = graph_fixture();
        let token = AtomicBool::new(false);
        let renumbered: Value = serde_json::from_str(
            &serde_json::to_string(&original)
                .unwrap()
                .replace("3 0 R", "30 0 R"),
        )
        .unwrap();
        assert!(compare_graphs(&original, &renumbered, &Changes::new(), None, &token).is_ok());
        let mut split = original.clone();
        split["qpdf"][1]["obj:8 0 R"] = original["qpdf"][1]["obj:3 0 R"].clone();
        split["qpdf"][1]["obj:5 0 R"]["value"]["/P"] = json!("8 0 R");
        assert!(compare_graphs(&original, &split, &Changes::new(), None, &token).is_err());
    }
    #[test]
    fn old_source_schema_defaults_new_capabilities_to_false() {
        let source: Source = serde_json::from_value(json!({"id":"a","path":"a.pdf","name":"a.pdf","bytes":1,"sha256":"x","kind":"pdf","features":[],"editable":true,"pages":1})).unwrap();
        assert!(
            !source.preserve_document
                && !source.can_create_editing_copy
                && source.removed_features.is_empty()
        );
    }
    #[test]
    fn type3_glyph_names_are_not_actions_or_article_threads() {
        let report = json!({"qpdf":[{}, {"obj:1 0 R":{"value":{"/A":"2 0 R","/B":"3 0 R"}}, "obj:2 0 R":{"stream":{"dict":{}}}, "obj:3 0 R":{"stream":{"dict":{}}}}]});
        assert!(inventory(&report).is_empty());
    }
    fn fixture_backend() -> (tempfile::TempDir, Backend) {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".pdfworkbench-workspace"), "test").unwrap();
        fs::create_dir(dir.path().join("tmp")).unwrap();
        let engine =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(if cfg!(target_os = "windows") {
                "binaries/qpdf-x86_64-pc-windows-msvc.exe"
            } else {
                "binaries/qpdf-aarch64-apple-darwin"
            });
        let backend = Backend(Arc::new(Inner {
            home: dir.path().into(),
            initialize_home: false,
            engine,
            sources: Mutex::new(HashMap::new()),
            stages: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
            busy: AtomicBool::new(false),
            metrics: Mutex::new(Vec::new()),
        }));
        (dir, backend)
    }
    #[test]
    fn managed_workspace_initializes_lazily_and_explicit_missing_workspace_stays_missing() {
        let (dir, mut backend) = fixture_backend();
        let missing = dir.path().join("not-mounted");
        Arc::get_mut(&mut backend.0).unwrap().home = missing.clone();
        assert!(backend.ensure_home().is_err());
        assert!(
            !missing.exists(),
            "An explicit missing workspace must never be recreated"
        );
        Arc::get_mut(&mut backend.0).unwrap().initialize_home = true;
        assert!(
            !missing.exists(),
            "Constructing the backend must not touch storage"
        );
        backend.ensure_home().unwrap();
        assert!(missing.join("tmp").is_dir());
        assert!(missing.join("projects").is_dir());
        assert!(missing.join(".pdfworkbench-workspace").is_file());
        fs::write(missing.join("tmp/keep.txt"), "keep").unwrap();
        backend.ensure_home().unwrap();
        assert_eq!(
            fs::read_to_string(missing.join("tmp/keep.txt")).unwrap(),
            "keep"
        );
    }

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("test-data")
            .join(name)
    }
    #[test]
    #[cfg(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    ))]
    fn real_preservation_and_explicit_copy_verify_graphs_and_keep_originals() {
        let (dir, backend) = fixture_backend();
        let token = AtomicBool::new(false);
        let mut paths = vec![
            fixture("links.pdf"),
            fixture("bookmarks.pdf"),
            fixture("tags.pdf"),
        ];
        if let Some(path) = std::env::var_os("PDFWORKBENCH_PUBLISHER_PDF") {
            paths.push(PathBuf::from(path));
        }
        for path in paths {
            let source = backend.register(&path, None, "pdf", &token).unwrap();
            assert!(
                source.preserve_document,
                "{} {:?}",
                source.name, source.features
            );
            if std::env::var_os("PDFWORKBENCH_PUBLISHER_PDF")
                .map(PathBuf::from)
                .as_ref()
                == Some(&path)
            {
                assert!(
                    source.can_create_editing_copy,
                    "The explicitly supplied publisher PDF must support a verified editing copy"
                );
            }
            let pages: Vec<_> = (1..=source.pages)
                .map(|page| PreservePage {
                    page,
                    rotation: if page == 1 { 90 } else { 0 },
                    crop: if page == 1 {
                        Some(CropMargins {
                            left: 12.25,
                            right: 12.5,
                            top: 18.1,
                            bottom: 18.1,
                        })
                    } else {
                        None
                    },
                })
                .collect();
            let preserved = preserve_impl(&backend, source.clone(), &pages, &token).unwrap();
            assert_eq!(preserved.features, source.features);
            let exported = export_to(
                &backend,
                preserved,
                dir.path().join(format!("{}.pdf", new_id())),
                Some(Optimization::LosslessThorough),
                None,
                &token,
            )
            .unwrap();
            assert!(exported
                .validation
                .iter()
                .any(|s| s.contains("streams") && s.contains("metadata")));
            if source.can_create_editing_copy {
                let copy = editing_copy_impl(&backend, source.clone(), &token).unwrap();
                assert!(copy.editable && copy.features.is_empty());
                assert_eq!(copy.pages, source.pages);
                assert!(!copy.removed_features.is_empty());
            }
            assert_eq!(hash_file(&path).unwrap(), source.sha256);
            assert!(preserve_impl(&backend, source.clone(), &[], &token).is_err());
            assert!(editing_copy_impl(&backend, source, &AtomicBool::new(true)).is_err());
        }
        let forms = backend
            .register(&fixture("forms.pdf"), None, "pdf", &token)
            .unwrap();
        assert!(!forms.preserve_document && !forms.can_create_editing_copy);
        assert!(editing_copy_impl(&backend, forms, &token).is_err());
    }

    #[test]
    #[cfg(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    ))]
    fn editing_copy_then_organization_export_and_reopen_preserves_selected_page_content() {
        let (dir, backend) = fixture_backend();
        let token = AtomicBool::new(false);
        let path = std::env::var_os("PDFWORKBENCH_PUBLISHER_PDF")
            .map(PathBuf::from)
            // The link fixture has a visible default border, which correctly
            // disqualifies an editing copy. Bookmarks exercise supported removal.
            .unwrap_or_else(|| fixture("bookmarks.pdf"));
        let original = backend.register(&path, None, "pdf", &token).unwrap();
        assert!(original.can_create_editing_copy && !original.editable);
        let protected_plan = [PageRef {
            source_id: original.id.clone(),
            page: 1,
            rotation: 0,
        }];
        assert!(assemble_impl(&backend, &protected_plan, &token).is_err());
        let copy = editing_copy_impl(&backend, original.clone(), &token).unwrap();
        let other = backend
            .register(&fixture("blank.pdf"), None, "pdf", &token)
            .unwrap();
        assert!(copy.editable && other.editable);
        let mut graphs = HashMap::new();
        let mut references = HashMap::new();
        for source in [&copy, &other] {
            let report = graph_report(&backend, Path::new(&source.path), &token, false).unwrap();
            references.insert(source.id.clone(), page_objects(&report).unwrap());
            graphs.insert(
                source.id.clone(),
                graph_report(&backend, Path::new(&source.path), &token, true).unwrap(),
            );
        }
        let cases = [
            (
                "reorder",
                (1..=copy.pages)
                    .rev()
                    .map(|p| (&copy, p, 0))
                    .collect::<Vec<_>>(),
            ),
            ("extract", vec![(&copy, copy.pages, 0)]),
            (
                "duplicate",
                vec![(&copy, 1, 0), (&copy, 1, 90), (&copy, copy.pages, 0)],
            ),
            (
                "merge",
                vec![(&copy, 1, 0), (&other, 1, 0), (&copy, copy.pages, 0)],
            ),
        ];
        for (operation, selected) in cases {
            let plan: Vec<_> = selected
                .iter()
                .map(|(source, page, rotation)| PageRef {
                    source_id: source.id.clone(),
                    page: *page,
                    rotation: *rotation,
                })
                .collect();
            let organized = assemble_impl(&backend, &plan, &token)
                .unwrap_or_else(|e| panic!("{operation}: {e}"));
            let exported = export_to(
                &backend,
                organized,
                dir.path().join(format!("{operation}.pdf")),
                None,
                None,
                &token,
            )
            .unwrap();
            // Reopen the actual exported bytes through the same preflight as
            // file-picker imports, then compare each intended page independently.
            // A fresh comparison per page permits intentional duplication while
            // still verifying every decoded content stream and resource graph.
            let reopened = backend
                .register(Path::new(&exported.path), None, "pdf", &token)
                .unwrap();
            assert!(
                reopened.editable && reopened.pages == plan.len(),
                "{operation}"
            );
            let report = graph_report(&backend, Path::new(&reopened.path), &token, false).unwrap();
            let output_refs = page_objects(&report).unwrap();
            let output_graph =
                graph_report(&backend, Path::new(&reopened.path), &token, true).unwrap();
            for (index, (source, page, rotation)) in selected.iter().enumerate() {
                let original_ref = references[&source.id][page - 1].clone();
                let mut changes = Changes::new();
                if *rotation != 0 {
                    let original_rotation =
                        inherited(&graphs[&source.id], &original_ref, "/Rotate")
                            .unwrap()
                            .unwrap_or(json!(0))
                            .as_i64()
                            .unwrap();
                    changes.insert(
                        original_ref.clone(),
                        HashMap::from([(
                            "/Rotate".into(),
                            Some(json!(
                                (original_rotation + i64::from(*rotation)).rem_euclid(360)
                            )),
                        )]),
                    );
                }
                compare_graphs(
                    &graphs[&source.id],
                    &output_graph,
                    &changes,
                    Some(&[(original_ref, output_refs[index].clone())]),
                    &token,
                )
                .unwrap_or_else(|e| panic!("{operation}, output page {}: {e}", index + 1));
            }
        }
        assert_eq!(hash_file(&path).unwrap(), original.sha256);
        assert_eq!(hash_file(Path::new(&copy.path)).unwrap(), copy.sha256);
        assert_eq!(hash_file(Path::new(&other.path)).unwrap(), other.sha256);
    }
    #[test]
    fn feature_inventory_blocks_nested_features_and_does_not_scan_text() {
        let value = json!({"pages":[{}],"qpdf":[{}, {"obj:1 0 R":{"value":{"/AcroForm":"2 0 R","/Names":{},"/StructTreeRoot":"3 0 R","/Outlines":"4 0 R","/PageLabels":{},"/OCProperties":{},"/Annots":["8 0 R"],"/Contents":"Text saying /ByteRange must not count"}},"obj:2 0 R":{"value":{"/FT":"/Sig"}}}]});
        let features = inventory(&value);
        for expected in [
            "forms",
            "bookmarks",
            "accessibility tags",
            "page labels",
            "annotations or links",
            "optional content layers",
            "digital signatures (unverified)",
        ] {
            assert!(features.contains(&expected.to_owned()), "{expected}");
        }
        assert!(inventory(&json!({"/Contents":"/AcroForm /ByteRange /Outlines"})).is_empty());
    }
    #[test]
    fn detects_encryption_attachments_and_actions() {
        let features = inventory(
            &json!({"encrypt":{"encrypted":true},"/EmbeddedFiles":{},"/OpenAction":"1 0 R"}),
        );
        assert!(features.contains(&"encryption".into()));
        assert!(features.contains(&"attachments or portfolios".into()));
        assert!(features.contains(&"unsupported opening action".into()));
    }
    #[test]
    fn output_names_and_existing_destinations_are_protected() {
        for name in ["../source.pdf", "a/b", "a\\b", ".", "a:b", ""] {
            assert!(safe_name(name).is_err());
        }
        assert_eq!(
            safe_name("รายงาน — neue Datei.pdf").unwrap(),
            "รายงาน — neue Datei.pdf"
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("original.pdf");
        fs::write(&path, b"unchanged").unwrap();
        assert!(protect_destination(&path, &[]).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"unchanged");
        assert!(protect_destination(&dir.path().join("new.pdf"), &[]).is_ok());
    }
    #[test]
    fn missing_workspace_never_gets_created() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("missing-ssd");
        let backend = Backend(Arc::new(Inner {
            home: home.clone(),
            initialize_home: false,
            engine: PathBuf::new(),
            sources: Mutex::new(HashMap::new()),
            stages: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
            busy: AtomicBool::new(false),
            metrics: Mutex::new(Vec::new()),
        }));
        assert!(backend.temp(".pdf").is_err());
        assert!(!home.exists());
    }
    #[test]
    fn project_versions_and_hashes_are_required() {
        assert!(validate_project(&json!({"schemaVersion":2,"sources":[]})).is_err());
        assert!(validate_project(
            &json!({"schemaVersion":1,"sources":[{"id":"a","path":"/tmp/a","sha256":"bad"}]})
        )
        .is_err());
        let valid = json!({"schemaVersion":1,"name":"Blank","sources":[],"pages":[{"id":"page","sourceId":null,"page":1,"rotation":0,"blank":{"width":595,"height":842}}],"history":[],"future":[]});
        assert!(validate_project(&valid).is_ok());
        let mut invalid = valid.clone();
        invalid["pages"][0]["rotation"] = json!(17);
        assert!(validate_project(&invalid).is_err());
    }
    #[test]
    #[cfg(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    ))]
    fn real_engine_preflight_protects_fixture_structures() {
        let (_dir, backend) = fixture_backend();
        let token = AtomicBool::new(false);
        let plain = backend
            .register(&fixture("studio-sample.pdf"), None, "pdf", &token)
            .unwrap();
        assert_eq!(plain.pages, 4);
        assert!(plain.editable, "{:?}", plain.features);
        for (name, feature) in [
            ("forms.pdf", "forms"),
            ("links.pdf", "annotations or links"),
            ("bookmarks.pdf", "bookmarks"),
            ("tags.pdf", "accessibility tags"),
            ("attachments.pdf", "attachments or portfolios"),
            ("signature-field.pdf", "digital signatures (unverified)"),
        ] {
            let source = backend
                .register(&fixture(name), None, "pdf", &token)
                .unwrap();
            assert!(!source.editable, "{name} unexpectedly editable");
            assert!(
                source.features.contains(&feature.to_owned()),
                "{name}: {:?}",
                source.features
            );
        }
        assert!(backend
            .register(&fixture("encrypted.pdf"), None, "pdf", &token)
            .is_err());
        assert!(backend
            .register(&fixture("malformed.pdf"), None, "pdf", &token)
            .is_err());
    }
    #[test]
    #[cfg(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    ))]
    fn real_export_reopens_optimizes_and_never_overwrites() {
        let (dir, backend) = fixture_backend();
        let token = AtomicBool::new(false);
        let source = backend
            .register(&fixture("studio-sample.pdf"), None, "pdf", &token)
            .unwrap();
        let destination = dir.path().join("export.pdf");
        let result = export_to(
            &backend,
            source.clone(),
            destination.clone(),
            Some(Optimization::LosslessThorough),
            Some(json!({"test":"native export"})),
            &token,
        )
        .unwrap();
        assert_eq!(result.source.pages, 4);
        assert_eq!(result.sha256, hash_file(&destination).unwrap());
        assert_eq!(hash_file(Path::new(&source.path)).unwrap(), source.sha256);
        assert!(dir.path().join("export.pdf.recipe.json").is_file());
        assert!(export_to(&backend, source, destination.clone(), None, None, &token).is_err());
        assert_eq!(result.sha256, hash_file(&destination).unwrap());
    }
    #[test]
    #[cfg(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    ))]
    fn optimization_presets_export_real_images_and_preserve_other_content() {
        let (dir, backend) = fixture_backend();
        let token = AtomicBool::new(false);
        let output_dir = fixture("optimization-lab.pdf")
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("tmp/optimization-results");
        fs::create_dir_all(&output_dir).unwrap();
        let mut evidence = vec![];
        for fixture_name in ["optimization-lab.pdf", "optimization-gray.pdf", "blank.pdf"] {
            let source = backend
                .register(&fixture(fixture_name), None, "pdf", &token)
                .unwrap();
            for preset in [
                Optimization::LosslessQuick,
                Optimization::LosslessThorough,
                Optimization::ImagesHigh,
                Optimization::ImagesBalanced,
                Optimization::ImagesSmall,
            ] {
                let preset_name = serde_json::to_value(preset)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned();
                let name = format!(
                    "{}-{preset_name}.pdf",
                    fixture_name.trim_end_matches(".pdf")
                );
                let destination = dir.path().join(&name);
                let result = export_to(
                    &backend,
                    source.clone(),
                    destination.clone(),
                    Some(preset),
                    Some(json!({"educationalFixture":fixture_name})),
                    &token,
                )
                .unwrap();
                assert_eq!(result.source.pages, source.pages);
                assert_eq!(result.source.features, source.features);
                assert_eq!(hash_file(Path::new(&source.path)).unwrap(), source.sha256);
                let settings = result.optimization.as_ref().unwrap();
                assert_eq!(settings["preset"], json!(preset));
                if preset.quality().is_some() && fixture_name != "blank.pdf" {
                    assert!(settings["changedImageObjects"].as_u64().unwrap() > 0);
                    assert!(
                        result.bytes < source.bytes,
                        "{name} must demonstrate real savings"
                    );
                } else {
                    assert_eq!(settings["changedImageObjects"], json!(0));
                }
                let receipt: Value = serde_json::from_slice(
                    &fs::read(dir.path().join(format!("{name}.recipe.json"))).unwrap(),
                )
                .unwrap();
                assert_eq!(&receipt["optimization"], settings);
                assert!(export_to(
                    &backend,
                    source.clone(),
                    destination.clone(),
                    Some(preset),
                    None,
                    &token
                )
                .is_err());
                fs::copy(destination, output_dir.join(&name)).unwrap();
                evidence.push(json!({"fixture":fixture_name,"output":name,"inputBytes":source.bytes,"outputBytes":result.bytes,"elapsedMs":result.elapsed_ms,"settings":settings}));
            }
        }
        let alpha = backend
            .register(&fixture("optimization-alpha.pdf"), None, "pdf", &token)
            .unwrap();
        let target = dir.path().join("alpha-lossy.pdf");
        let error = export_to(
            &backend,
            alpha.clone(),
            target.clone(),
            Some(Optimization::ImagesBalanced),
            None,
            &token,
        )
        .err()
        .unwrap();
        assert!(error.contains("transparency"), "{error}");
        assert!(!target.exists());
        export_to(
            &backend,
            alpha,
            dir.path().join("alpha-lossless.pdf"),
            Some(Optimization::LosslessThorough),
            None,
            &token,
        )
        .unwrap();
        fs::write(
            output_dir.join("measurements.json"),
            serde_json::to_vec_pretty(&evidence).unwrap(),
        )
        .unwrap();
    }

    #[test]
    #[cfg(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    ))]
    fn image_policy_still_rejects_text_geometry_navigation_and_pixel_dimension_changes() {
        let (_dir, backend) = fixture_backend();
        let token = AtomicBool::new(false);
        let left = graph_report(&backend, &fixture("optimization-lab.pdf"), &token, true).unwrap();
        for key in ["/MediaBox", "/Contents", "/Annots", "/Resources"] {
            let mut right = left.clone();
            let object = object_map(&right)
                .unwrap()
                .iter()
                .find(|(_, o)| object_dict(o).and_then(|d| d.get("/Type")) == Some(&json!("/Page")))
                .unwrap()
                .0
                .clone();
            right["qpdf"][1][&object]["value"][key] = Value::Null;
            assert!(
                compare_graphs_with_images(&left, &right, &Changes::new(), None, &token, true)
                    .is_err(),
                "{key}"
            );
        }
        let mut right = left.clone();
        let object = object_map(&right)
            .unwrap()
            .iter()
            .find(|(_, o)| object_dict(o).and_then(|d| d.get("/Subtype")) == Some(&json!("/Image")))
            .unwrap()
            .0
            .clone();
        right["qpdf"][1][&object]["stream"]["dict"]["/Width"] = json!(10);
        assert!(
            compare_graphs_with_images(&left, &right, &Changes::new(), None, &token, true).is_err()
        );
        assert!(serde_json::from_value::<Optimization>(json!("invented")).is_err());
        let cancelled_path = backend.0.home.join("tmp/cancelled-optimization.pdf");
        let source = backend
            .register(&fixture("optimization-lab.pdf"), None, "pdf", &token)
            .unwrap();
        assert!(export_to(
            &backend,
            source,
            cancelled_path.clone(),
            Some(Optimization::ImagesSmall),
            None,
            &AtomicBool::new(true)
        )
        .is_err());
        assert!(!cancelled_path.exists());
    }

    #[test]
    #[cfg(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    ))]
    fn cancelled_job_and_modified_source_are_rejected() {
        let (dir, backend) = fixture_backend();
        let job = backend.job(Some("job".into())).unwrap();
        assert!(backend.job(Some("second".into())).is_err());
        job.token.store(true, Ordering::SeqCst);
        assert!(backend
            .qpdf(&["--version".into()], &job.token, 4096)
            .is_err());
        drop(job);
        assert!(backend.job(Some("third".into())).is_ok());
        let copy = dir.path().join("source.pdf");
        fs::copy(fixture("studio-sample.pdf"), &copy).unwrap();
        let source = backend
            .register(&copy, None, "pdf", &AtomicBool::new(false))
            .unwrap();
        OpenOptions::new()
            .append(true)
            .open(copy)
            .unwrap()
            .write_all(b"modified")
            .unwrap();
        assert!(backend.verify_source(&source).is_err());
    }

    #[test]
    fn cancelled_project_commit_does_not_create_a_destination() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("cancelled.pdfworkbench.json");
        let mut staged = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        staged.write_all(b"{\"schemaVersion\":1}").unwrap();
        assert!(commit_new(staged, &destination, &AtomicBool::new(true)).is_err());
        assert!(!destination.exists());
    }

    #[test]
    #[cfg(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    ))]
    fn failed_or_cancelled_restore_preserves_existing_source_registry() {
        let (_dir, backend) = fixture_backend();
        let token = AtomicBool::new(false);
        let original = backend
            .register(&fixture("studio-sample.pdf"), None, "pdf", &token)
            .unwrap();
        let replacement = backend
            .inspect(
                &fixture("blank.pdf"),
                Some(original.id.clone()),
                "pdf",
                &token,
            )
            .unwrap();
        let project = json!({"schemaVersion":1,"name":"Restore transaction","sources":[replacement],"pages":[{"id":"page-one","sourceId":original.id,"page":1,"rotation":0}],"history":[],"future":[]});
        assert!(restore_sources(&backend, &project, &AtomicBool::new(true)).is_err());
        assert_eq!(backend.get(&original.id).unwrap().sha256, original.sha256);
        // Even a valid replacement PDF cannot hijack an existing identity when
        // the UI discards a late result from a cancelled project-open request.
        assert!(restore_sources(&backend, &project, &token).is_err());
        assert_eq!(backend.get(&original.id).unwrap().sha256, original.sha256);
        let mut invalid = project.clone();
        invalid["sources"][0]["id"] = json!("new-id");
        invalid["pages"][0]["sourceId"] = json!("new-id");
        invalid["sources"][0]["sha256"] = json!("0".repeat(64));
        assert!(restore_sources(&backend, &invalid, &token).is_err());
        assert!(backend.get("new-id").is_err());
        assert_eq!(backend.get(&original.id).unwrap().sha256, original.sha256);
    }
}
