// core/errors.js — Standardized Aeldorado API Error Handling
// Aeldorado by Solanacy Technologies

/**
 * Error code registry — maps to HTTP status codes.
 * All API responses use these exact codes for consistency.
 */
export const ERROR_CODES = {
  // 400 — Bad Request
  INVALID_REQUEST:       { status: 400, code: "invalid_request",       message: "The request body is malformed or missing required fields." },
  MESSAGE_TOO_LONG:      { status: 400, code: "message_too_long",      message: "Message exceeds the maximum allowed length (32,000 characters)." },
  INVALID_PROVIDER:      { status: 400, code: "invalid_provider",      message: "The specified AI provider is not supported." },
  INVALID_MODEL:         { status: 400, code: "invalid_model",         message: "The specified model is not available for this provider." },

  // 401 — Unauthorized
  INVALID_API_KEY:       { status: 401, code: "invalid_api_key",       message: "The API key provided is invalid or has been revoked." },
  MISSING_API_KEY:       { status: 401, code: "missing_api_key",       message: "Authorization header with a valid API key is required." },
  INVALID_AUTH_TOKEN:    { status: 401, code: "invalid_auth_token",    message: "Firebase authentication token is invalid or expired." },
  DECRYPTION_FAILED:     { status: 401, code: "decryption_failed",     message: "Failed to decrypt your stored API key. Check your encryption password." },

  // 402 — Payment Required
  PAYMENT_REQUIRED:      { status: 402, code: "payment_required",      message: "Subscription activation required. Please visit the dashboard." },
  INSUFFICIENT_CREDITS:  { status: 402, code: "insufficient_credits",  message: "Your account has no remaining API call credits. Upgrade your plan." },

  // 403 — Forbidden
  INSUFFICIENT_PERMISSION: { status: 403, code: "insufficient_permission", message: "Your current plan does not have access to this resource." },
  ACCOUNT_SUSPENDED:     { status: 403, code: "account_suspended",     message: "Your account has been suspended due to policy violations." },
  CONVERSATION_LIMIT_REACHED: { status: 403, code: "conversation_limit_reached", message: "Free tier allows up to 5 active conversations at a time. Delete an old conversation or wait for one to expire (24h), or upgrade your plan for unlimited conversations." },

  // 404 — Not Found
  AGENT_NOT_FOUND:       { status: 404, code: "agent_not_found",       message: "The requested agent does not exist." },
  USER_NOT_FOUND:        { status: 404, code: "user_not_found",        message: "The requested user does not exist." },
  VAULT_KEY_NOT_FOUND:   { status: 404, code: "vault_key_not_found",   message: "No API key found in vault for the specified provider." },

  // 429 — Rate Limited
  DAILY_LIMIT_EXCEEDED:  { status: 429, code: "daily_limit_exceeded",  message: "You have exceeded your API call limit for the current 5-hour window. This resets 5 hours after your first request in the window." },
  WEEKLY_LIMIT_EXCEEDED: { status: 429, code: "weekly_limit_exceeded", message: "You have exceeded your API call limit for the current 7-day window. This resets 7 days after your first request in the window." },
  MONTHLY_LIMIT_EXCEEDED:{ status: 429, code: "monthly_limit_exceeded",message: "You have exceeded your API call limit for the current 28-day window. This resets 28 days after your first request in the window." },
  RATE_LIMIT_EXCEEDED:   { status: 429, code: "rate_limit_exceeded",   message: "Too many requests. Please slow down." },

  // 500 — Server Error
  AGENT_ERROR:           { status: 500, code: "agent_error",           message: "The AI agent encountered an internal error while processing your request." },
  INTERNAL_ERROR:        { status: 500, code: "internal_error",        message: "An unexpected server error occurred." },

  // 503 — Service Unavailable
  SERVICE_UNAVAILABLE:   { status: 503, code: "service_unavailable",   message: "The service is temporarily unavailable. Please try again later." },
};

/**
 * Create a standardized error response object.
 *
 * @param {string} errorKey  - Key from ERROR_CODES
 * @param {string} [detail]  - Optional additional detail message
 * @returns {{ status: number, body: object }}
 */
export function createError(errorKey, detail = null) {
  const err = ERROR_CODES[errorKey];
  if (!err) {
    return {
      status: 500,
      body: {
        error: { code: "internal_error", message: "Unknown error occurred.", detail },
        meta: { powered_by: "Aeldorado by Solanacy" },
      },
    };
  }

  return {
    status: err.status,
    body: {
      error: {
        code: err.code,
        message: err.message,
        ...(detail ? { detail } : {}),
      },
      meta: { powered_by: "Aeldorado by Solanacy" },
    },
  };
}

/**
 * Send a standardized error response via Express.
 *
 * @param {import("express").Response} res
 * @param {string} errorKey
 * @param {string} [detail]
 */
export function sendError(res, errorKey, detail = null) {
  const { status, body } = createError(errorKey, detail);
  return res.status(status).json(body);
}
