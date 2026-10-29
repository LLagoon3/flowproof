import type { ServerResponse } from 'node:http'

import { sanitizeText } from '../evidence/sanitize.js'

// The stable Studio error envelope: `{"error":{"code","message"}}`. Codes are uppercase
// snake case; messages are sanitized, bounded, and never echo rejected request values.

export interface ErrorEnvelope {
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/
const MAX_ERROR_MESSAGE_LENGTH = 300
const FALLBACK_MESSAGE = 'The Studio could not complete the request.'

export function createErrorEnvelope(code: string, message: string): ErrorEnvelope {
  const safeCode = ERROR_CODE_PATTERN.test(code) ? code : 'INTERNAL_ERROR'
  const safeMessage = sanitizeText(String(message)).value.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_MESSAGE_LENGTH).trimEnd()
  return Object.freeze({ error: Object.freeze({ code: safeCode, message: safeMessage || FALLBACK_MESSAGE }) })
}

/** Thrown by Studio handlers to return a specific envelope; anything else becomes a 500. */
export class StudioRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'StudioRequestError'
    this.status = status >= 400 && status <= 599 ? status : 500
    this.code = code
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status >= 400 && status <= 599 ? status : 500, createErrorEnvelope(code, message))
}

export function sendInternalError(res: ServerResponse): void {
  sendError(res, 500, 'INTERNAL_ERROR', FALLBACK_MESSAGE)
}
