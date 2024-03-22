param (
    [string]$folder = "~/Workbench/Data/",
    [string]$startDate = "2017-08-17",
    [string]$symbol = "ETHUSDT"
)

$folder += "${symbol}/"
if (-not (Test-Path $folder)) {
    New-Item -ItemType Directory -Force -Path $folder
}
$today = [DateTime]::Today
$date = [DateTime]::ParseExact($startDate, "yyyy-MM-dd", $null)
while ($true) {
    # Download data from a url
    $url = "https://data.binance.vision/data/spot/daily/klines/${symbol}/1m/${symbol}-1m-$($date.ToString("yyy-MM-dd")).zip"
    $output = "$folder${symbol}-$($date.ToString("yyyy-MM-dd")).zip"
    if (Test-Path $output) {
        $date = $date.AddDays(1)
        continue;
    }
    write-host "Downloading $url $output"
    Invoke-WebRequest -Uri $url -OutFile $output
    $date = $date.AddDays(1)
    if ($date -ge $today) {
        break
    }
}