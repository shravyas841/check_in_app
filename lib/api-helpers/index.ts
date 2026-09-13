import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

/**
 * Standardized API response helpers. Wrap a handler so that:
 *  - thrown Errors become 500s with a generic message
 *  - thrown ApiError instances become the right status + JSON body
 *  - uncaught parse failures in the body don't leak
 *
 * Usage:
 *   export const POST = respond(async (req) => {
 *     const body = parseBody(req, MySchema);
 *     ...
 *     return NextResponse.json({ ok: true });
 *   }, { auth: 'admin' });
 */
export class ApiError extends Error {
    constructor(public status: number, message: string, public details?: unknown, public code?: string) {
        super(message);
    }
}

export function badRequest(message: string, details?: unknown) {
    return new ApiError(400, message, details, 'VALIDATION_ERROR');
}
export function unauthorized(message = 'Unauthorized') {
    return new ApiError(401, message, undefined, 'AUTHENTICATION_REQUIRED');
}
export function forbidden(message = 'Forbidden') {
    return new ApiError(403, message, undefined, 'AUTHORIZATION_ERROR');
}
export function notFound(message = 'Not found') {
    return new ApiError(404, message, undefined, 'NOT_FOUND');
}
export function conflict(message: string) {
    return new ApiError(409, message, undefined, 'CONFLICT');
}

export function apiErrorResponse(message: string, status: number, code?: string, details?: unknown) {
    const fallback = status === 401 ? 'AUTHENTICATION_REQUIRED' : status === 403 ? 'AUTHORIZATION_ERROR' : status === 400 ? 'VALIDATION_ERROR' : status >= 500 ? 'DATABASE_ERROR' : 'REQUEST_ERROR';
    return NextResponse.json({ success: false, error: message, code: code || fallback, ...(details ? { details } : {}) }, { status });
}

type Handler = (req: NextRequest, ctx: { params: any }) => Promise<Response> | Response;

type Options = {
    /** Required role(s) for this endpoint. */
    auth?: 'admin' | 'organizer' | 'scanner' | 'any' | readonly string[];
    /** Allow unauthenticated (public) requests. */
    public?: boolean;
};

const ROLE_SETS: Record<string, readonly string[]> = {
    admin: ['ADMIN'],
    organizer: ['ADMIN', 'ORGANIZER', 'ORGANISER'],
    scanner: ['ADMIN', 'ORGANIZER', 'ORGANISER', 'SCANNER'],
    any: ['ADMIN', 'ORGANIZER', 'ORGANISER', 'SCANNER'],
};

export function respond(handler: Handler, options: Options = {}) {
    return async (req: NextRequest, ctx: { params: any }) => {
        const requestId = req.headers.get('x-request-id')?.slice(0, 100) || randomUUID();
        try {
                if (!options.public) {
                const { getSession, hasRole } = await import('@/lib/auth');
                const session = await getSession();
                if (!session) return NextResponse.json({ success: false, error: 'Unauthorized', code: 'AUTHENTICATION_REQUIRED' }, { status: 401 });
                if (options.auth) {
                    const allowed = Array.isArray(options.auth) ? options.auth : ROLE_SETS[options.auth as string] || [];
                    if (!hasRole(session.user.role, allowed)) {
                        return NextResponse.json({ success: false, error: 'Forbidden', code: 'AUTHORIZATION_ERROR' }, { status: 403 });
                    }
                }
            }
            const response = await handler(req, ctx);
            response.headers.set('x-request-id', requestId);
            return response;
        } catch (err) {
            if (err instanceof ApiError) {
                return NextResponse.json(
                    { success: false, error: err.message, code: err.code || (err.status >= 500 ? 'DATABASE_ERROR' : 'REQUEST_ERROR'), ...(err.details ? { details: err.details } : {}) },
                    { status: err.status, headers: { 'x-request-id': requestId } },
                );
            }
            try {
                const { logAudit } = await import('@/lib/logger');
                await logAudit({
                    action: 'EXPORT',
                    resource: 'AUTH',
                    userId: 'system',
                    userName: 'api',
                    details: { url: req.url, method: req.method, err: String(err) },
                });
            } catch {
                console.error('[api]', err);
            }
            return NextResponse.json({ success: false, error: 'Internal server error', code: 'DATABASE_ERROR', requestId }, { status: 500, headers: { 'x-request-id': requestId } });
        }
    };
}

/**
 * Parse a JSON body against a Zod schema. Throws ApiError(400) on failure.
 */
export async function parseBody<T extends z.ZodTypeAny>(req: NextRequest, schema: T): Promise<z.infer<T>> {
    let json: unknown;
    try {
        json = await req.json();
    } catch {
        throw badRequest('Invalid JSON body');
    }
    const result = schema.safeParse(json);
    if (!result.success) {
        throw badRequest('Validation failed', result.error.issues);
    }
    return result.data;
}

/**
 * Parse query params. Throws ApiError(400) on failure.
 */
export function parseQuery<T extends z.ZodTypeAny>(req: NextRequest, schema: T): z.infer<T> {
    const url = new URL(req.url);
    const obj: Record<string, string | string[]> = {};
    url.searchParams.forEach((v, k) => {
        if (k in obj) {
            const cur = obj[k];
            obj[k] = Array.isArray(cur) ? [...cur, v] : [cur as string, v];
        } else {
            obj[k] = v;
        }
    });
    const result = schema.safeParse(obj);
    if (!result.success) {
        throw badRequest('Invalid query', result.error.issues);
    }
    return result.data;
}
