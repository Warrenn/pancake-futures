param (
    $AwsProfile = "busyweb-admin-role",
    [String]
    $Region = "af-south-1",
    [Switch]
    $Redeploy
)

if ($Redeploy) {
    Get-ChildItem -Path .\index.js, .\package.json, .\package-lock.json |
    Compress-Archive -DestinationPath .\pancake-futures-application.zip -CompressionLevel Optimal -Force
    aws s3 cp .\pancake-futures-application.zip s3://secure-artifacts-93648082bbed41458cac8d7814803d3c/pancake-futures/pancake-futures-application.zip --profile $AwsProfile --region $Region
}

$scalingGroup = $(aws cloudformation describe-stacks --stack-name pancake-futures-stack --query "Stacks[0].Outputs[?OutputKey=='ScalingGroup'].OutputValue | [0]"  --profile $AwsProfile --region $Region)
aws autoscaling set-desired-capacity --auto-scaling-group-name $scalingGroup --desired-capacity 0  --profile $AwsProfile --region $Region
Start-Sleep 3
aws autoscaling set-desired-capacity --auto-scaling-group-name $scalingGroup --desired-capacity 1  --profile $AwsProfile --region $Region