param (
    $AwsProfile = "",
    [String]
    $Region = "af-south-1",
    [String]
    $RepoUri= "352842384468.dkr.ecr.af-south-1.amazonaws.com/kicking-can-by-bit",
    [String]
    $ImageName = "kickingcanbybit",
    [String]
    $ImageTag = "latest"
)

if ([string]::IsNullOrWhiteSpace($AwsProfile)) {
    $AwsProfile = $env:AWS_PROFILE
}

if ([string]::IsNullOrWhiteSpace($AwsProfile)) {
    $AwsProfile = "default"
}

docker build . -t $ImageName

# Get ECR login command
aws ecr get-login-password --region $Region --profile $AwsProfile | docker login --username AWS --password-stdin $RepoUri

# Tag local image with ECR repository URI
$ecrUri = "${RepoUri}:${ImageTag}"
docker tag "${ImageName}:${ImageTag}" $ecrUri

# Push image to ECR repository
docker push $ecrUri
