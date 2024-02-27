param (
    [String]
    $Message = ""
)

if ([string]::IsNullOrWhiteSpace($Message)) {
    $Message = "$(Get-Date)"
}

git add .
git commit -m $Message
git push

./Tag-Repo.ps1
./Quick-Push.ps1