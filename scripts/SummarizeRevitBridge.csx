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
        .ToList();

string groups = string.Join(";", instances
    .GroupBy(instance => instance.Symbol?.Family?.Name ?? "")
    .OrderBy(group => group.Key)
    .Select(group => group.Key + "=" + group.Count().ToString()));

return "BRIDGE_SUMMARY|document=" + document.Title
    + "|view=" + (document.ActiveView?.Name ?? "")
    + "|instances=" + instances.Count.ToString()
    + "|families=" + instances.Select(instance => instance.Symbol?.Family?.Name ?? "").Distinct().Count().ToString()
    + "|groups=" + groups;
