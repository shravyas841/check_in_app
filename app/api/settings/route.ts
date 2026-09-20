import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession, hasRole, ADMIN_ROLES } from '@/lib/auth';
import { logAudit } from '@/lib/logger';
import { sanitizeRichText, safeExternalUrl } from '@/lib/sanitize-html';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const config = await prisma.siteConfig.findUnique({
            where: { id: 'default' }
        });

        if (!config) return NextResponse.json(null);

        const settings = config.settings && typeof config.settings === 'object' && !Array.isArray(config.settings)
            ? config.settings as Record<string, unknown>
            : {};
        // SiteConfig also stores operational secrets and staff-only controls.
        // Keep the public storefront contract, but never expose those internal
        // sections through this unauthenticated branding endpoint.
        const {
            scannerDevices: _scannerDevices,
            checkInPolicy: _checkInPolicy,
            eventSettings: _eventSettings,
            ...publicSettings
        } = settings;

        return NextResponse.json({ siteSettings: publicSettings });
    } catch (error) {
        console.error('Failed to read settings:', error);
        return NextResponse.json(null);
    }
}

export async function POST(request: Request) {
    try {
        const session = await getSession();
        if (!session || !hasRole(session.user.role, ADMIN_ROLES)) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const { siteSettings } = body;
        if (!siteSettings || typeof siteSettings !== 'object' || Array.isArray(siteSettings)) {
            return NextResponse.json({ success: false, error: 'Invalid site settings' }, { status: 400 });
        }

        const input = siteSettings as Record<string, any>;
        const sanitizedSettings = {
            ...input,
            announcement: input.announcement
                ? {
                    ...input.announcement,
                    message: sanitizeRichText(input.announcement.message),
                    linkUrl: safeExternalUrl(input.announcement.linkUrl) || '',
                }
                : input.announcement,
            customPages: Array.isArray(input.customPages)
                ? input.customPages.map((page: Record<string, any>) => ({
                    ...page,
                    content: sanitizeRichText(page.content),
                    slug: typeof page.slug === 'string' ? page.slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 80) : '',
                }))
                : [],
        };

        // Need to fetch existing config first to merge if only partial data sent,
        // although currently the frontend sends everything.
        // But let's be safe and assume we might need to merge or create defaults.

        await prisma.siteConfig.upsert({
            where: { id: 'default' },
            create: {
                id: 'default',
                settings: sanitizedSettings,
                updatedAt: new Date()
            },
            update: {
                settings: sanitizedSettings
            }
        });

        await logAudit({
            action: 'SETTINGS_UPDATE',
            resource: 'SETTINGS',
            resourceId: 'default',
            details: {
                updatedKeys: [
                    siteSettings ? 'siteSettings' : null,
                ].filter(Boolean),
            },
            userId: session.user.id,
            userName: session.user.name || session.user.email,
            userRole: session.user.role,
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Failed to save settings:', error);
        return NextResponse.json({ success: false, error: 'Failed to save settings' }, { status: 500 });
    }
}
