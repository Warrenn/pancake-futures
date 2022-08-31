param (
    [String]
    $VpcId = "",
    [String]
    $AwsProfile = "busyweb-admin-role",
    [String]
    $Region = "af-south-1"
)

if ([string]::IsNullOrEmpty($AwsProfile)) {
    $AwsProfile = $Env:AWS_PROFILE
}

if ([string]::IsNullOrEmpty($AwsProfile)) {
    $AwsProfile = "default"
}

if ([string]::IsNullOrEmpty($VpcId)) {
    $VpcId = $(ConvertFrom-Json([string]::Join("", $(aws ec2 describe-vpcs --query "Vpcs[].VpcId" --region $Region --profile $AwsProfile))))[0]
}

$IpAddress = (Invoke-WebRequest -uri "http://ifconfig.me/ip").Content

$SubnetId = $(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VpcId --query "Subnets[0].SubnetId" --region $Region --profile $AwsProfile)

Get-ChildItem -Path .\index.js, .\package.json, .\package-lock.json |
Compress-Archive -DestinationPath .\pancake-futures-application.zip -CompressionLevel Optimal -Force
aws s3 cp .\pancake-futures-application.zip s3://secure-artifacts-93648082bbed41458cac8d7814803d3c/pancake-futures/pancake-futures-application.zip --profile $AwsProfile --region $Region

aws cloudformation deploy `
    --template-file .\cloud-formation.yaml `
    --stack-name "pancake-futures-stack" `
    --profile $AwsProfile `
    --region $Region `
    --parameter-overrides `
        UserIp="$IpAddress" `
        VPCId=$VpcId `
        KeyPair="auto-invest" `
        SubnetId=$SubnetId `
    --capabilities CAPABILITY_NAMED_IAM 