param (
    [Switch]
    $CancelIncrement
)

$packagePath = Join-Path $PSScriptRoot "package.json"
$pjson = [System.IO.File]::ReadAllText($packagePath)
$packageData = ConvertFrom-Json $pjson
$version = $packageData.version

if (-not $CancelIncrement) {
    $parts = $version.Split('.')
    $lastIndex = $parts.Length - 1;
    [uint32] $revison = [uint32]::Parse($parts[$lastIndex])
    $revison = $revison + 1
    $parts[$lastIndex] = "${revison}"
    $version = [String]::Join(".", $parts)
    $packageData.version = $version

    $pjson = ConvertTo-Json $packageData
    [System.IO.File]::WriteAllText($packagePath, $pjson)
    npm install

    git add ./package.json ./package-lock.json
    git commit -m "auto incremented package version to ${version}"
    git push
}

git tag $version
git push origin --tags