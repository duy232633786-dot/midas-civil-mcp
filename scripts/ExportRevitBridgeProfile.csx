double ToMetres(double value) => Autodesk.Revit.DB.UnitUtils.ConvertFromInternalUnits(
    value, Autodesk.Revit.DB.UnitTypeId.Meters);
object PointData(Autodesk.Revit.DB.XYZ point) => point == null ? null : new[]
{
    ToMetres(point.X), ToMetres(point.Y), ToMetres(point.Z)
};
string TextParameter(Autodesk.Revit.DB.Element element, string name)
{
    Autodesk.Revit.DB.Parameter parameter = element.LookupParameter(name);
    return parameter == null ? "" : (parameter.AsString() ?? parameter.AsValueString() ?? "");
}

string outputDirectory = System.IO.Path.Combine(
    System.Environment.GetEnvironmentVariable("MIDAS_WORKDIR") ??
    System.Environment.GetFolderPath(System.Environment.SpecialFolder.MyDocuments),
    "revit-import");
System.IO.Directory.CreateDirectory(outputDirectory);
string outputPath = System.IO.Path.Combine(outputDirectory, "cable-stay-live-export.json");

Autodesk.Revit.DB.View activeView = document.ActiveView;
List<Autodesk.Revit.DB.FamilyInstance> instances =
    new Autodesk.Revit.DB.FilteredElementCollector(document)
        .OfClass(typeof(Autodesk.Revit.DB.FamilyInstance))
        .Cast<Autodesk.Revit.DB.FamilyInstance>()
        .Where(instance =>
        {
            string familyName = instance.Symbol?.Family?.Name ?? "";
            return familyName.StartsWith("BRG_3SP300_", StringComparison.Ordinal)
                || familyName.StartsWith("BRG_LOD300_", StringComparison.Ordinal);
        })
        .OrderBy(instance => instance.Symbol?.Family?.Name ?? "")
        .ThenBy(instance => instance.Id.Value)
        .ToList();

List<Dictionary<string, object>> records = new List<Dictionary<string, object>>();
double globalMinX = double.PositiveInfinity;
double globalMinY = double.PositiveInfinity;
double globalMinZ = double.PositiveInfinity;
double globalMaxX = double.NegativeInfinity;
double globalMaxY = double.NegativeInfinity;
double globalMaxZ = double.NegativeInfinity;

foreach (Autodesk.Revit.DB.FamilyInstance instance in instances)
{
    string familyName = instance.Symbol?.Family?.Name ?? "";
    Autodesk.Revit.DB.Transform transform = instance.GetTransform();
    Autodesk.Revit.DB.BoundingBoxXYZ box = instance.get_BoundingBox(null);
    Dictionary<string, object> record = new Dictionary<string, object>
    {
        ["elementId"] = instance.Id.Value,
        ["family"] = familyName,
        ["type"] = instance.Symbol?.Name ?? "",
        ["category"] = instance.Category?.Name ?? "",
        ["mark"] = TextParameter(instance, "Mark"),
        ["comments"] = TextParameter(instance, "Comments"),
        ["componentCode"] = TextParameter(instance, "DYLIGHT_Component_Code"),
        ["componentRole"] = TextParameter(instance, "DYLIGHT_Component_Role"),
        ["designStatus"] = TextParameter(instance, "DYLIGHT_Design_Status"),
        ["originM"] = PointData(transform?.Origin),
        ["basisXM"] = transform == null ? null : new[] { transform.BasisX.X, transform.BasisX.Y, transform.BasisX.Z },
        ["basisYM"] = transform == null ? null : new[] { transform.BasisY.X, transform.BasisY.Y, transform.BasisY.Z },
        ["basisZM"] = transform == null ? null : new[] { transform.BasisZ.X, transform.BasisZ.Y, transform.BasisZ.Z }
    };

    if (box != null)
    {
        double minX = ToMetres(box.Min.X);
        double minY = ToMetres(box.Min.Y);
        double minZ = ToMetres(box.Min.Z);
        double maxX = ToMetres(box.Max.X);
        double maxY = ToMetres(box.Max.Y);
        double maxZ = ToMetres(box.Max.Z);
        globalMinX = Math.Min(globalMinX, minX);
        globalMinY = Math.Min(globalMinY, minY);
        globalMinZ = Math.Min(globalMinZ, minZ);
        globalMaxX = Math.Max(globalMaxX, maxX);
        globalMaxY = Math.Max(globalMaxY, maxY);
        globalMaxZ = Math.Max(globalMaxZ, maxZ);
        record["boundingBoxM"] = new Dictionary<string, object>
        {
            ["min"] = new[] { minX, minY, minZ },
            ["max"] = new[] { maxX, maxY, maxZ },
            ["center"] = new[] { (minX + maxX) / 2.0, (minY + maxY) / 2.0, (minZ + maxZ) / 2.0 },
            ["size"] = new[] { maxX - minX, maxY - minY, maxZ - minZ }
        };
    }

    Autodesk.Revit.DB.LocationPoint locationPoint = instance.Location as Autodesk.Revit.DB.LocationPoint;
    Autodesk.Revit.DB.LocationCurve locationCurve = instance.Location as Autodesk.Revit.DB.LocationCurve;
    if (locationPoint != null)
    {
        record["location"] = new Dictionary<string, object>
        {
            ["kind"] = "point",
            ["pointM"] = PointData(locationPoint.Point),
            ["rotationRad"] = locationPoint.Rotation
        };
    }
    else if (locationCurve?.Curve != null)
    {
        record["location"] = new Dictionary<string, object>
        {
            ["kind"] = "curve",
            ["startM"] = PointData(locationCurve.Curve.GetEndPoint(0)),
            ["endM"] = PointData(locationCurve.Curve.GetEndPoint(1)),
            ["lengthM"] = ToMetres(locationCurve.Curve.Length)
        };
    }

    try
    {
        List<object> adaptivePoints = new List<object>();
        foreach (Autodesk.Revit.DB.ElementId pointId in
            Autodesk.Revit.DB.AdaptiveComponentInstanceUtils.GetInstancePlacementPointElementRefIds(instance))
        {
            Autodesk.Revit.DB.ReferencePoint referencePoint =
                document.GetElement(pointId) as Autodesk.Revit.DB.ReferencePoint;
            if (referencePoint != null) adaptivePoints.Add(PointData(referencePoint.Position));
        }
        if (adaptivePoints.Count > 0) record["adaptivePointsM"] = adaptivePoints;
    }
    catch { }

    // Material-volume evaluation forces Revit to expand every nested solid and is
    // intentionally omitted from this lightweight analytical-geometry export.
    record["materials"] = new List<string>();
    records.Add(record);
}

List<Dictionary<string, object>> familySummary = records
    .GroupBy(record => (string)record["family"])
    .OrderBy(group => group.Key)
    .Select(group => new Dictionary<string, object>
    {
        ["family"] = group.Key,
        ["count"] = group.Count(),
        ["marks"] = group.Select(record => (string)record["mark"])
            .Where(mark => !string.IsNullOrWhiteSpace(mark)).OrderBy(mark => mark).ToList(),
        ["materials"] = new List<string>()
    })
    .ToList();

Dictionary<string, object> export = new Dictionary<string, object>
{
    ["schema"] = "dylight.revit.bridge-profile.v1",
    ["exportedAtUtc"] = DateTime.UtcNow.ToString("O"),
    ["document"] = new Dictionary<string, object>
    {
        ["title"] = document.Title,
        ["path"] = document.PathName,
        ["isModified"] = document.IsModified,
        ["activeView"] = activeView?.Name ?? ""
    },
    ["units"] = "metres",
    ["familyInstanceCount"] = records.Count,
    ["familyCount"] = familySummary.Count,
    ["modelBoundsM"] = records.Count == 0 ? null : new Dictionary<string, object>
    {
        ["min"] = new[] { globalMinX, globalMinY, globalMinZ },
        ["max"] = new[] { globalMaxX, globalMaxY, globalMaxZ },
        ["size"] = new[] { globalMaxX - globalMinX, globalMaxY - globalMinY, globalMaxZ - globalMinZ }
    },
    ["families"] = familySummary,
    ["instances"] = records,
    ["warning"] = "Read-only BIM geometry export. Structural idealisation and engineering verification are not included."
};

string json = Newtonsoft.Json.JsonConvert.SerializeObject(
    export, Newtonsoft.Json.Formatting.Indented);
System.IO.File.WriteAllText(outputPath, json, new System.Text.UTF8Encoding(false));

return new
{
    ok = true,
    outputPath = outputPath,
    bytes = new System.IO.FileInfo(outputPath).Length,
    document = document.Title,
    view = activeView?.Name ?? "",
    familyInstances = records.Count,
    families = familySummary.Count,
    modelBoundsM = records.Count == 0 ? null : new
    {
        min = new[] { globalMinX, globalMinY, globalMinZ },
        max = new[] { globalMaxX, globalMaxY, globalMaxZ }
    }
};
