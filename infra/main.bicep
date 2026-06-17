targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the environment')
param environmentName string

@description('Location for all resources')
param location string

@secure()
@description('GitHub token for Copilot SDK')
param githubToken string = ''

@description('Deploy Azure OpenAI for BYOM. Set to true to provision AI resources.')
param useAzureModel bool = false

@description('Azure OpenAI model deployment name (must support Copilot SDK encrypted content)')
@allowed([
  'o4-mini'
  'o3'
  'o3-mini'
  'gpt-5'
  'gpt-5-mini'
  'gpt-5.1'
  'gpt-5.1-mini'
  'gpt-5.1-nano'
  'gpt-5.2-codex'
  'codex-mini'
])
param azureModelName string = 'o4-mini'

@description('Azure OpenAI model version (must match the model name; see `az cognitiveservices model list`)')
param azureModelVersion string = '2025-04-16'

@description('Model deployment capacity in thousands of TPM. Reasoning models doing multi-tool calls need headroom.')
param azureModelCapacity int = 100

@description('Foundry project endpoint for the hosted specialist agents (optional; set after agents are deployed).')
param foundryProjectEndpoint string = ''

@description('Inventory specialist Foundry hosted agent name (optional).')
param agentInventoryName string = ''

@description('Demand-Forecast specialist Foundry hosted agent name (optional).')
param agentForecastName string = ''

@description('Supplier & Compliance specialist Foundry hosted agent name (optional).')
param agentComplianceName string = ''

@description('Ops Review multi-agent workflow Foundry hosted agent name (optional).')
param agentOpsName string = ''

var tags = { 'azd-env-name': environmentName }
var resourceSuffix = take(uniqueString(subscription().id, environmentName), 6)
var shortName = take(replace(environmentName, '-', ''), 10)

@description('Name of an existing resource group to deploy into. Defaults to the azd convention rg-<env> when not set.')
param resourceGroupName string = 'rg-${environmentName}'

// Reference the (pre-existing) resource group to deploy resources into. azd
// ensures this group exists before deployment (it creates it if missing).
resource rg 'Microsoft.Resources/resourceGroups@2023-07-01' existing = {
  name: resourceGroupName
}

module resources './resources.bicep' = {
  name: 'resources'
  scope: rg
  params: {
    environmentName: environmentName
    location: location
    tags: tags
    githubToken: githubToken
    resourceSuffix: resourceSuffix
    shortName: shortName
    useAzureModel: useAzureModel
    azureModelName: azureModelName
    azureModelVersion: azureModelVersion
    azureModelCapacity: azureModelCapacity
    foundryProjectEndpoint: foundryProjectEndpoint
    agentInventoryName: agentInventoryName
    agentForecastName: agentForecastName
    agentComplianceName: agentComplianceName
    agentOpsName: agentOpsName
  }
}

output AZURE_CONTAINER_APP_API_URL string = resources.outputs.apiContainerAppUrl
output AZURE_CONTAINER_APP_WEB_URL string = resources.outputs.webContainerAppUrl
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.registryLoginServer
output AZURE_CONTAINER_REGISTRY_NAME string = resources.outputs.registryName
output AZURE_MODEL_NAME string = useAzureModel ? azureModelName : ''
output AZURE_OPENAI_ENDPOINT string = useAzureModel ? resources.outputs.azureOpenAiEndpoint : ''
