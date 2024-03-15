import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export class CdkAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // You can also use cfnParameters to get the following details.
    // we can refine it later
    const githubOwner = "your-github-username";
    const githubRepo = "your-github-repo";
    const githubBranch = "your-github-branch";
    const mainDomain = "example.com";
    const subDomain = "subdomain";

    // The code that defines your stack goes here

    const websiteBucket = new cdk.aws_s3.Bucket(this, "WebsiteBucket", {
      // we are not adding a bucket name to prevent conflicts in future
      blockPublicAccess: {
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
      },
      autoDeleteObjects: true,
      websiteIndexDocument: "index.html",
      websiteErrorDocument: "index.html",
      publicReadAccess: true,
      /** Make sure you set each field in blockPublicAccess to false or some of it,
      before allowing publicReadAccess, else the deployment will get error,both are
      mutually dependent and the error message is not at all helpful  */
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const websiteRedirectBucket = new cdk.aws_s3.Bucket(
      this,
      "WebsiteRedirectBucket",
      {
        blockPublicAccess: {
          blockPublicAcls: false,
          blockPublicPolicy: false,
          ignorePublicAcls: false,
          restrictPublicBuckets: false,
        },
        // redirect buckets will have conflict if you set publicReadAccess to true
        websiteRedirect: {
          // add your subdomain and main domain
          // host names should read www.subdomain.example.com
          hostName: `www.${subDomain}.${mainDomain}`,
          protocol: cdk.aws_s3.RedirectProtocol.HTTPS,
        },
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }
    );

    const hostedZone = cdk.aws_route53.HostedZone.fromLookup(
      this,
      "PortfolioHostedZone",
      {
        domainName: mainDomain,
      }
    );

    const certificate = new cdk.aws_certificatemanager.Certificate(
      this,
      "PortfolioCertificate",
      {
        domainName: `www.${subDomain}.${mainDomain}`,
        subjectAlternativeNames: [`${subDomain}.${mainDomain}`],
        /**  validation: CertificateValidation.fromDns(zone) */
        validation:
          cdk.aws_certificatemanager.CertificateValidation.fromDnsMultiZone({
            [`${subDomain}.${mainDomain}`]: hostedZone,
            [`www.${subDomain}.${mainDomain}`]: hostedZone,
          }),
      }
    );

    // main website distribution
    const distributionForWebsite = new cdk.aws_cloudfront.Distribution(
      this,
      "WebsiteDistribution",
      {
        defaultBehavior: {
          origin: new cdk.aws_cloudfront_origins.S3Origin(websiteBucket),
          viewerProtocolPolicy:
            cdk.aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        httpVersion: cdk.aws_cloudfront.HttpVersion.HTTP2, // default
        domainNames: [`www.${subDomain}.${mainDomain}`],
        certificate: certificate,
      }
    );

    // redirect distribution
    const distributionForRedirect = new cdk.aws_cloudfront.Distribution(
      this,
      "WebsiteRedirectDistribution",
      {
        defaultBehavior: {
          origin: new cdk.aws_cloudfront_origins.S3Origin(
            websiteRedirectBucket
          ),
          viewerProtocolPolicy:
            cdk.aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        httpVersion: cdk.aws_cloudfront.HttpVersion.HTTP2, // default
        domainNames: [`${subDomain}.${mainDomain}`],
        certificate: certificate,
      }
    );

    new cdk.aws_route53.ARecord(this, "WebsiteARecord", {
      zone: hostedZone,
      target: cdk.aws_route53.RecordTarget.fromAlias(
        new cdk.aws_route53_targets.CloudFrontTarget(distributionForWebsite)
      ),
      recordName: `www.${subDomain}`,
    });

    new cdk.aws_route53.ARecord(this, "WebsiteRedirectARecord", {
      zone: hostedZone,
      target: cdk.aws_route53.RecordTarget.fromAlias(
        new cdk.aws_route53_targets.CloudFrontTarget(distributionForRedirect)
      ),
      recordName: `${subDomain}`,
    });

    // Code build
    const buildSpecFile = cdk.aws_codebuild.BuildSpec.fromObject({
      version: "0.2",
      phases: {
        install: {
          "runtime-versions": {
            nodejs: 18,
          },
        },
        pre_build: {
          commands: ["npm install"],
        },
        build: {
          commands: [
            "npm run build",
            "aws s3 sync ./dist/ s3://$S3_BUCKET --delete",
          ],
        },
        post_build: {
          commands: [
            "echo 'Build completed successfully'",
            "aws cloudfront create-invalidation --distribution-id $DISTRIBUTION_ID --paths '/*'",
          ],
        },
      },
      artifacts: {
        files: ["**/*"],
      },
    });

    const codeBuild = new cdk.aws_codebuild.Project(this, "codeBuildProject", {
      buildSpec: buildSpecFile,
      environment: {
        buildImage: cdk.aws_codebuild.LinuxBuildImage.STANDARD_7_0,
        environmentVariables: {
          S3_BUCKET: { value: websiteBucket.bucketName },
          DISTRIBUTION_ID: { value: distributionForWebsite.distributionId },
        },
      },

      source: cdk.aws_codebuild.Source.gitHub({
        owner: githubOwner,
        repo: githubRepo,
        webhook: true,
        webhookFilters: [
          cdk.aws_codebuild.FilterGroup.inEventOf(
            cdk.aws_codebuild.EventAction.PUSH
          ).andBranchIs(githubBranch),
        ],
      }),
    });

    // add put object, delete object permissions to codebuild
    websiteBucket.grantReadWrite(codeBuild);
    websiteBucket.grantDelete(codeBuild);
    // add create invalidation permissions to codebuild
    distributionForWebsite.grantCreateInvalidation(codeBuild);
    distributionForWebsite.grantCreateInvalidation(codeBuild);

    // Code pipeline
    const sourceOutput = new cdk.aws_codepipeline.Artifact();
    const buildOutput = new cdk.aws_codepipeline.Artifact();

    const pipeline = new cdk.aws_codepipeline.Pipeline(
      this,
      "WebsitePipeline",
      {
        pipelineType: cdk.aws_codepipeline.PipelineType.V2,
        stages: [
          {
            stageName: "Source",
            actions: [
              new cdk.aws_codepipeline_actions.GitHubSourceAction({
                actionName: "GitHub_Source",
                owner: githubOwner,
                repo: githubRepo,
                branch: githubBranch,
                // secrets manager is costly, 0.4$ + tax per month per secret
                // also it costs 0.05$ per 10,000 requests
                // it is unsafe to store secrets in plain text in code
                // anybody who has access to your cloudformation template can see your secrets
                // although if you want to test you can temporarily use plaintext
                // oauthToken: cdk.SecretValue.unsafePlainText("your-github-token"),
                oauthToken: cdk.SecretValue.secretsManager("my-secrets", {
                  jsonField: "github_token",
                }),
                output: sourceOutput,
              }),
            ],
          },
          {
            stageName: "Build",
            actions: [
              new cdk.aws_codepipeline_actions.CodeBuildAction({
                actionName: "CodeBuild",
                project: codeBuild,
                input: sourceOutput,
                outputs: [buildOutput],
              }),
            ],
          },
        ],
      }
    );
  }
}
