double ToM(double value) => Autodesk.Revit.DB.UnitUtils.ConvertFromInternalUnits(
    value, Autodesk.Revit.DB.UnitTypeId.Meters);
double[] P(Autodesk.Revit.DB.XYZ point) => new[]
{
    ToM(point.X), ToM(point.Y), ToM(point.Z)
};
string ParameterText(Autodesk.Revit.DB.Element element, string name)
{
    Autodesk.Revit.DB.Parameter parameter = element.LookupParameter(name);
    return parameter == null ? "" : (parameter.AsString() ?? parameter.AsValueString() ?? "");
}

List<Autodesk.Revit.DB.FamilyInstance> instances =
    new Autodesk.Revit.DB.FilteredElementCollector(document)
        .OfClass(typeof(Autodesk.Revit.DB.FamilyInstance))
        .Cast<Autodesk.Revit.DB.FamilyInstance>()
        .Where(instance =>
        {
            string family = instance.Symbol?.Family?.Name ?? "";
            return family.StartsWith("BRG_3SP300_", StringComparison.Ordinal)
                || family.StartsWith("BRG_LOD300_", StringComparison.Ordinal);
        })
        .OrderBy(instance => instance.Symbol?.Family?.Name ?? "")
        .ThenBy(instance => instance.Id.Value)
        .ToList();

List<Dictionary<string, object>> records = new List<Dictionary<string, object>>();
foreach (Autodesk.Revit.DB.FamilyInstance instance in instances)
{
    string family = instance.Symbol?.Family?.Name ?? "";
    Autodesk.Revit.DB.Transform transform = instance.GetTransform();
    Dictionary<string, object> record = new Dictionary<string, object>
    {
        ["elementId"] = instance.Id.Value,
        ["family"] = family,
        ["type"] = instance.Symbol?.Name ?? "",
        ["mark"] = ParameterText(instance, "Mark"),
        ["componentCode"] = ParameterText(instance, "DYLIGHT_Component_Code"),
        ["componentRole"] = ParameterText(instance, "DYLIGHT_Component_Role"),
        ["designStatus"] = ParameterText(instance, "DYLIGHT_Design_Status"),
        ["originM"] = P(transform.Origin),
        ["basisX"] = new[] { transform.BasisX.X, transform.BasisX.Y, transform.BasisX.Z },
        ["basisY"] = new[] { transform.BasisY.X, transform.BasisY.Y, transform.BasisY.Z },
        ["basisZ"] = new[] { transform.BasisZ.X, transform.BasisZ.Y, transform.BasisZ.Z }
    };

    Autodesk.Revit.DB.LocationPoint pointLocation = instance.Location as Autodesk.Revit.DB.LocationPoint;
    Autodesk.Revit.DB.LocationCurve curveLocation = instance.Location as Autodesk.Revit.DB.LocationCurve;
    if (pointLocation != null)
    {
        record["locationKind"] = "point";
        record["locationPointM"] = P(pointLocation.Point);
        record["rotationRad"] = pointLocation.Rotation;
    }
    else if (curveLocation?.Curve != null)
    {
        record["locationKind"] = "curve";
        record["curveStartM"] = P(curveLocation.Curve.GetEndPoint(0));
        record["curveEndM"] = P(curveLocation.Curve.GetEndPoint(1));
    }

    if (family.EndsWith("_ADAPTIVE", StringComparison.Ordinal))
    {
        List<double[]> points = new List<double[]>();
        foreach (Autodesk.Revit.DB.ElementId pointId in
            Autodesk.Revit.DB.AdaptiveComponentInstanceUtils.GetInstancePlacementPointElementRefIds(instance))
        {
            Autodesk.Revit.DB.ReferencePoint referencePoint =
                document.GetElement(pointId) as Autodesk.Revit.DB.ReferencePoint;
            if (referencePoint != null) points.Add(P(referencePoint.Position));
        }
        record["adaptivePointsM"] = points;
    }
    records.Add(record);
}

Dictionary<string, object> export = new Dictionary<string, object>
{
    ["schema"] = "dylight.revit.bridge-skeleton.v1",
    ["exportedAtUtc"] = DateTime.UtcNow.ToString("O"),
    ["documentTitle"] = document.Title,
    ["documentPath"] = document.PathName,
    ["documentModified"] = document.IsModified,
    ["activeView"] = document.ActiveView?.Name ?? "",
    ["units"] = "metres",
    ["instanceCount"] = records.Count,
    ["familyCount"] = records.Select(record => (string)record["family"]).Distinct().Count(),
    ["instances"] = records,
    ["warning"] = "Read-only geometry skeleton. It is not a verified finite-element model."
};

string outputDirectory = System.IO.Path.Combine(
    System.Environment.GetEnvironmentVariable("MIDAS_WORKDIR") ??
    System.Environment.GetFolderPath(System.Environment.SpecialFolder.MyDocuments),
    "revit-import");
System.IO.Directory.CreateDirectory(outputDirectory);
string outputPath = System.IO.Path.Combine(outputDirectory, "cable-stay-live-skeleton.json");
string json = Newtonsoft.Json.JsonConvert.SerializeObject(
    export, Newtonsoft.Json.Formatting.Indented);
System.IO.File.WriteAllText(outputPath, json, new System.Text.UTF8Encoding(false));

return "BRIDGE_SKELETON_EXPORTED|path=" + outputPath
    + "|bytes=" + new System.IO.FileInfo(outputPath).Length.ToString()
    + "|instances=" + records.Count.ToString()
    + "|families=" + ((int)export["familyCount"]).ToString();
