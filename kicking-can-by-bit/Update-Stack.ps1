param (
    [String]
    $VpcId = "",
    [String]
    $SubnetId = "",
    [String]
    $AwsProfile = "",
    [String]
    $Region = "af-south-1",
    [String]
    $StackName = "kicking-can-by-bit-stack"
)

if ([string]::IsNullOrEmpty($AwsProfile)) {
    $AwsProfile = $Env:AWS_PROFILE
}

if ([string]::IsNullOrEmpty($AwsProfile)) {
    $AwsProfile = "default"
}

if ([string]::IsNullOrEmpty($VpcId)) {
    $VpcId = $(aws ec2 describe-vpcs --query "Vpcs[].VpcId" --region $Region --profile $AwsProfile --output text)
}

if ([string]::IsNullOrEmpty($SubnetId)) {
    $SubnetId = $(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VpcId" --query "Subnets[0].SubnetId" --region $Region --profile $AwsProfile --output text)
}

aws cloudformation deploy `
    --template-file "$PSScriptRoot/cfn/cloud-formation.yaml" `
    --stack-name $StackName `
    --profile $AwsProfile `
    --region $Region `
    --parameter-overrides `
    VPCId=$VpcId `
    SubnetId=$SubnetId `
    --capabilities CAPABILITY_NAMED_IAM 

    & .\Rescale.ps1 -AwsProfile $AwsProfile -Region $Region -StackName $StackName