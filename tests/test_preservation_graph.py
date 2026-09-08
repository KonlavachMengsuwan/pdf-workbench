"""Owned synthetic regression cases; no user document is accessed."""
import copy
import unittest
from preservation_graph import compare, REFERENCE


def fixture():
    return {"qpdf": [{"jsonversion": 2, "pdfversion": "1.7"}, {
        "trailer": {"value": {"/Root": "1 0 R", "/Size": 9, "/ID": ["b:00", "b:01"]}},
        "obj:1 0 R": {"value": {"/Type": "/Catalog", "/Pages": "2 0 R", "/StructTreeRoot": "6 0 R", "/Metadata": "7 0 R", "/Names": {"/Dests": {"/Names": ["u:chapter", ["3 0 R", "/Fit"]]}}}},
        "obj:2 0 R": {"value": {"/Type": "/Pages", "/Kids": ["3 0 R"], "/Count": 1}},
        "obj:3 0 R": {"value": {"/Type": "/Page", "/Parent": "2 0 R", "/MediaBox": [0, 0, 612, 792], "/Contents": "4 0 R", "/Annots": ["5 0 R"]}},
        "obj:4 0 R": {"stream": {"dict": {}, "data": "QlQgL0YxIDEyIFRmIEVUCg=="}},
        "obj:5 0 R": {"value": {"/Subtype": "/Link", "/P": "3 0 R", "/A": {"/S": "/URI", "/URI": "u:https://example.com"}, "/Contents": "u:literal 100 0 R"}},
        "obj:6 0 R": {"value": {"/Type": "/StructTreeRoot", "/K": {"/Type": "/StructElem", "/Pg": "3 0 R", "/K": 0}}},
        "obj:7 0 R": {"stream": {"dict": {"/Type": "/Metadata", "/Subtype": "/XML"}, "data": "PHhtcC8+"}},
        "obj:8 0 R": {"value": {"unused": True}},
    }]}


def renumber(source):
    data = copy.deepcopy(source)
    def convert(value):
        if isinstance(value, str) and REFERENCE.fullmatch(value):
            number, generation, marker = value.split()
            return f"{int(number)*10} {generation} {marker}"
        if isinstance(value, dict): return {k: convert(v) for k, v in value.items()}
        if isinstance(value, list): return [convert(v) for v in value]
        return value
    objects = {}
    for key, value in data["qpdf"][1].items():
        objects["obj:" + convert(key[4:]) if key.startswith("obj:") else key] = convert(value)
    data["qpdf"][1] = objects
    return data


class PreservationGraphTests(unittest.TestCase):
    def setUp(self):
        self.source = fixture()
        self.output = renumber(self.source)

    def test_renumbering_and_serialization_changes_are_allowed(self):
        self.output["qpdf"][1]["trailer"]["value"].update({"/Size": 901, "/ID": ["b:00", "b:ff"], "/Type": "/XRef", "/W": [1, 2, 1]})
        del self.output["qpdf"][1]["obj:80 0 R"]
        result = compare(self.source, self.output)
        self.assertTrue(result["equivalent"])
        self.assertEqual(result["pairedReachableObjects"], 7)
        self.assertEqual(result["decodedStreamsCompared"], 2)

    def test_exact_rotation_is_allowed_only_on_approved_page(self):
        self.output["qpdf"][1]["obj:30 0 R"]["value"]["/Rotate"] = 90
        self.assertTrue(compare(self.source, self.output, {"3 0 R": {"/Rotate": 90}})["equivalent"])
        self.assertFalse(compare(self.source, self.output)["equivalent"])
        self.assertFalse(compare(self.source, self.output, {"3 0 R": {"/Rotate": 180}})["equivalent"])

    def test_approved_crop_does_not_allow_other_page_changes(self):
        page = self.output["qpdf"][1]["obj:30 0 R"]["value"]
        page["/CropBox"] = [10, 20, 600, 770]
        allowed = {"3 0 R": {"/CropBox": [10, 20, 600, 770]}}
        self.assertTrue(compare(self.source, self.output, allowed)["equivalent"])
        page["/MediaBox"] = [0, 0, 400, 600]
        self.assertFalse(compare(self.source, self.output, allowed)["equivalent"])

    def test_missing_requested_rotation_is_rejected(self):
        self.assertFalse(compare(self.source, self.output, {"3 0 R": {"/Rotate": 90}})["equivalent"])

    def test_modified_decoded_stream_is_rejected(self):
        self.output["qpdf"][1]["obj:40 0 R"]["stream"]["data"] = "Y29udGVudCBsb3Nz"
        self.assertFalse(compare(self.source, self.output)["equivalent"])

    def test_link_action_change_is_rejected(self):
        self.output["qpdf"][1]["obj:50 0 R"]["value"]["/A"]["/URI"] = "u:https://different.example"
        self.assertFalse(compare(self.source, self.output)["equivalent"])

    def test_removed_xmp_is_rejected(self):
        del self.output["qpdf"][1]["obj:10 0 R"]["value"]["/Metadata"]
        self.assertFalse(compare(self.source, self.output)["equivalent"])

    def test_tag_page_target_alias_change_is_rejected(self):
        self.output["qpdf"][1]["obj:90 0 R"] = copy.deepcopy(self.output["qpdf"][1]["obj:30 0 R"])
        self.output["qpdf"][1]["obj:60 0 R"]["value"]["/K"]["/Pg"] = "90 0 R"
        self.assertFalse(compare(self.source, self.output)["equivalent"])

    def test_distinct_references_may_not_collapse_silently(self):
        self.source["qpdf"][1]["obj:1 0 R"]["value"]["custom"] = "9 0 R"
        self.source["qpdf"][1]["obj:9 0 R"] = copy.deepcopy(self.source["qpdf"][1]["obj:7 0 R"])
        self.output["qpdf"][1]["obj:10 0 R"]["value"]["custom"] = "70 0 R"
        self.assertFalse(compare(self.source, self.output)["equivalent"])

    def test_named_destination_coordinates_are_checked(self):
        self.output["qpdf"][1]["obj:10 0 R"]["value"]["/Names"]["/Dests"]["/Names"][1] = ["30 0 R", "/FitH", 700]
        self.assertFalse(compare(self.source, self.output)["equivalent"])

    def test_custom_trailer_data_is_checked(self):
        self.source["qpdf"][1]["trailer"]["value"]["custom"] = "u:keep"
        self.output["qpdf"][1]["trailer"]["value"]["custom"] = "u:changed"
        self.assertFalse(compare(self.source, self.output)["equivalent"])

    def test_literal_string_resembling_reference_is_not_followed(self):
        self.assertTrue(compare(self.source, self.output)["equivalent"])
        self.output["qpdf"][1]["obj:50 0 R"]["value"]["/Contents"] = "u:literal 200 0 R"
        self.assertFalse(compare(self.source, self.output)["equivalent"])

    def test_missing_referenced_object_is_rejected(self):
        del self.output["qpdf"][1]["obj:70 0 R"]
        self.assertFalse(compare(self.source, self.output)["equivalent"])


if __name__ == "__main__": unittest.main()
