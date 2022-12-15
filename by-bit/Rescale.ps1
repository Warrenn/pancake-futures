param (
    $AwsProfile = "busyweb-admin",
    [String]
    $Region = "af-south-1",
    [Switch]
    $Redeploy
)

if ($Redeploy) {
    & tsc --build ./tsconfig.json
    Get-ChildItem -Path .\package.json, .\package-lock.json, .\out, .\src |
    Compress-Archive -DestinationPath .\by-bit-application.zip -CompressionLevel Optimal -Force
    aws s3 cp .\by-bit-application.zip s3://secure-artifacts-93648082bbed41458cac8d7814803d3c/by-bit/by-bit-application.zip --profile $AwsProfile --region $Region
}

$scalingGroup = $(aws cloudformation describe-stacks --stack-name by-bit-stack --query "Stacks[0].Outputs[?OutputKey=='ScalingGroup'].OutputValue | [0]"  --profile $AwsProfile --region $Region)
aws autoscaling set-desired-capacity --auto-scaling-group-name $scalingGroup --desired-capacity 0  --profile $AwsProfile --region $Region
Start-Sleep 3
aws autoscaling set-desired-capacity --auto-scaling-group-name $scalingGroup --desired-capacity 1  --profile $AwsProfile --region $Region