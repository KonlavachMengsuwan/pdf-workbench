//! Explicit, versioned export policy. No image exception applies to other tools.
use crate::Result;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Optimization {
    LosslessQuick,
    LosslessThorough,
    ImagesHigh,
    ImagesBalanced,
    ImagesSmall,
}
impl Optimization {
    pub fn quality(self) -> Option<u8> {
        match self {
            Self::ImagesHigh => Some(90),
            Self::ImagesBalanced => Some(75),
            Self::ImagesSmall => Some(50),
            _ => None,
        }
    }
    pub fn args(self) -> Vec<String> {
        let mut args = vec![
            "--object-streams=generate".into(),
            "--stream-data=compress".into(),
            "--remove-unreferenced-resources=no".into(),
        ];
        if self == Self::LosslessQuick {
            args.push("--compression-level=6".into());
        } else {
            args.extend(["--recompress-flate".into(), "--compression-level=9".into()]);
        }
        if let Some(quality) = self.quality() {
            args.extend([
                "--optimize-images".into(),
                format!("--jpeg-quality={quality}"),
                "--keep-inline-images".into(),
                "--oi-min-width=128".into(),
                "--oi-min-height=128".into(),
                "--oi-min-area=16384".into(),
            ]);
        }
        args
    }
    pub fn settings(self, changed_images: usize) -> Value {
        json!({"schemaVersion":1,"preset":self,"losslessStructural":self.quality().is_none(),"jpegQuality":self.quality(),"downsample":false,"rasterizePages":false,"changedImageObjects":changed_images,"engine":"qpdf 12.4.1","arguments":self.args()})
    }
}

/// Only JPEG payload/filter changes of ordinary 8-bit RGB/gray image XObjects
/// are approved. All remaining dictionary values go through the graph matcher.
/// Masks, custom decode arrays and color spaces fail closed if changed.
pub fn image_change(a: &Value, b: &Value) -> Result<Option<(Value, Value)>> {
    let Some(ad) = a.pointer("/stream/dict").and_then(Value::as_object) else {
        return Ok(None);
    };
    if ad.get("/Subtype") != Some(&json!("/Image"))
        || a.pointer("/stream/data") == b.pointer("/stream/data")
    {
        return Ok(None);
    }
    let limitation = "Image compression encountered transparency, a mask, custom decoding, or an unsupported image format. Choose Quick lossless or Thorough lossless; no export was saved.";
    let channels = match ad.get("/ColorSpace").and_then(Value::as_str) {
        Some("/DeviceRGB") => 3,
        Some("/DeviceGray") => 1,
        _ => return Err(limitation.into()),
    };
    if ad.get("/BitsPerComponent").and_then(Value::as_u64) != Some(8)
        || [
            "/SMask",
            "/Mask",
            "/Decode",
            "/SMaskInData",
            "/ImageMask",
            "/Alternates",
            "/OPI",
        ]
        .iter()
        .any(|k| ad.contains_key(*k))
    {
        return Err(limitation.into());
    }
    let width = ad.get("/Width").and_then(Value::as_u64).ok_or(limitation)?;
    let height = ad
        .get("/Height")
        .and_then(Value::as_u64)
        .ok_or(limitation)?;
    if width <= 128
        || height <= 128
        || width > 65535
        || height > 65535
        || width * height > 40_000_000
    {
        return Err(limitation.into());
    }
    let bd = b
        .pointer("/stream/dict")
        .and_then(Value::as_object)
        .ok_or(limitation)?;
    if bd.get("/Filter") != Some(&json!("/DCTDecode")) || bd.contains_key("/DecodeParms") {
        return Err(
            "Image compression produced an unexpected filter. Export was not saved.".into(),
        );
    }
    let data = b
        .pointer("/stream/data")
        .and_then(Value::as_str)
        .ok_or(limitation)?;
    let jpeg = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "Invalid JPEG stream encoding")?;
    if jpeg_dimensions(&jpeg) != Some((width, height, channels)) {
        return Err("Compressed JPEG dimensions or color components changed unexpectedly. Export was not saved.".into());
    }
    let mut expected = a.clone();
    let mut actual = b.clone();
    for value in [&mut expected, &mut actual] {
        let stream = value
            .get_mut("stream")
            .and_then(Value::as_object_mut)
            .ok_or(limitation)?;
        stream.remove("data");
        let dict = stream
            .get_mut("dict")
            .and_then(Value::as_object_mut)
            .ok_or(limitation)?;
        dict.remove("/Filter");
        dict.remove("/DecodeParms");
    }
    Ok(Some((expected, actual)))
}

fn jpeg_dimensions(data: &[u8]) -> Option<(u64, u64, u64)> {
    if !data.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    let mut i = 2;
    while i + 4 <= data.len() {
        if data[i] != 0xff {
            return None;
        }
        while data.get(i) == Some(&0xff) {
            i += 1;
        }
        let marker = *data.get(i)?;
        i += 1;
        if marker == 0xda || marker == 0xd9 {
            return None;
        }
        let len = u16::from_be_bytes([*data.get(i)?, *data.get(i + 1)?]) as usize;
        if len < 2 || i.checked_add(len)? > data.len() {
            return None;
        }
        if marker == 0xc0 || marker == 0xc2 {
            if len < 8 || data[i + 2] != 8 {
                return None;
            }
            return Some((
                u16::from_be_bytes([data[i + 5], data[i + 6]]) as u64,
                u16::from_be_bytes([data[i + 3], data[i + 4]]) as u64,
                data[i + 7] as u64,
            ));
        }
        i += len;
    }
    None
}
