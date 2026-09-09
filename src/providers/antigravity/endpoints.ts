export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const CLOUDCODE_BASE_URL = 'https://cloudcode-pa.googleapis.com';
export const LOAD_CODE_ASSIST_ENDPOINT = `${CLOUDCODE_BASE_URL}/v1internal:loadCodeAssist`;
export const FETCH_AVAILABLE_MODELS_ENDPOINT = `${CLOUDCODE_BASE_URL}/v1internal:fetchAvailableModels`;
export const RETRIEVE_USER_QUOTA_ENDPOINT = `${CLOUDCODE_BASE_URL}/v1internal:retrieveUserQuota`;
export const RETRIEVE_USER_QUOTA_SUMMARY_ENDPOINT = `${CLOUDCODE_BASE_URL}/v1internal:retrieveUserQuotaSummary`;

export const LSP_RETRIEVE_QUOTA_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
export const LSP_GET_USER_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
export const LSP_GET_COMMAND_MODELS_PATH = '/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs';
