param (
    $AwsProfile = "",
    [String]
    $Region = "af-south-1",
    [String]
    $StackName = "kicking-can-by-bit-stack"
)

if ([string]::IsNullOrWhiteSpace($AwsProfile)) {
    $AwsProfile = $env:AWS_PROFILE
}

if ([string]::IsNullOrWhiteSpace($AwsProfile)) {
    $AwsProfile = "default"
}

$scalingGroup = $(aws cloudformation describe-stacks --stack-name $StackName --query "Stacks[0].Outputs[?OutputKey=='ScalingGroup'].OutputValue | [0]"  --profile $AwsProfile --region $Region --output text)
aws autoscaling set-desired-capacity --auto-scaling-group-name $scalingGroup --desired-capacity 0 --profile $AwsProfile --region $Region
while ($true) {
    try {   
        $count = [int]$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-name $scalingGroup --query "AutoScalingGroups[0].Instances[?LifecycleState=='InService'] | length(@)")
        if ($count -eq 0) {
            break;
        }
    }
    catch {
        break;
    }
}

aws autoscaling set-desired-capacity --auto-scaling-group-name $scalingGroup --desired-capacity 1 --profile $AwsProfile --region $Region