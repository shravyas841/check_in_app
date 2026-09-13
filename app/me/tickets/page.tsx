'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useUser } from '@clerk/nextjs';
import {Ticket, Calendar, MapPin, CheckCircle, Loader2, ArrowRight, Download, Send} from '@/components/icons';
import { useToast } from '@/components/Toaster';

interface TicketItem {
    id: string;
    name: string;
    email: string | null;
    status: string;
    lifecycleStatus: string;
    checkedIn: boolean;
    amountPaid?: number | null;
    netAmount?: number | null;
    createdAt: string;
    ticketType?: { name: string } | null;
    deliveryHistory?: { id: string; success: boolean; createdAt: string }[];
    event?: {
        id: string;
        name: string;
        date: string;
        venue: string | null;
        imageUrl?: string | null;
    };
}

function money(n: number | null | undefined) {
    if (!n) return 'Free';
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n / 100);
}

function StatusPill({ status }: { status: string }) {
    const s = status.replace(/_/g, ' ');
    const cls =
        status === 'checked_in' ? 'bg-green-500/15 text-green-400 border border-green-500/30' :
        status === 'paid' ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30' :
        status === 'cancelled' || status === 'refunded' ? 'bg-red-500/15 text-red-400 border border-red-500/30' :
        status === 'partially_refunded' ? 'bg-yellow-500/15 text-yellow-400 border border-yellow-500/30' :
        'bg-zinc-700/40 text-zinc-300 border border-zinc-600/40';
    return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>{s.toUpperCase()}</span>;
}

export default function MyTicketsPage() {
    const { isSignedIn, isLoaded, user } = useUser();
    const { showToast } = useToast();
    const [tickets, setTickets] = useState<TicketItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<'upcoming' | 'past' | 'all'>('upcoming');
    const [emailingId, setEmailingId] = useState<string | null>(null);

    useEffect(() => {
        if (!isLoaded) return;
        if (!isSignedIn) {
            setLoading(false);
            return;
        }
        fetch('/api/me/tickets')
            .then((r) => r.json())
            .then((d) => setTickets(Array.isArray(d) ? d : []))
            .catch(() => showToast('Failed to load tickets', 'error'))
            .finally(() => setLoading(false));
    }, [isLoaded, isSignedIn]);

    const now = Date.now();
    const filtered = tickets.filter((t) => {
        const d = t.event?.date ? new Date(t.event.date).getTime() : 0;
        if (filter === 'upcoming') return d >= now;
        if (filter === 'past') return d < now;
        return true;
    });

    const resendTicket = async (id: string) => {
        setEmailingId(id);
        try {
            const res = await fetch('/api/tickets/deliver', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticketId: id }),
            });
            const data = await res.json();
            showToast(data.success ? 'Ticket sent to your email' : (data.error || 'Failed to send'), data.success ? 'success' : 'error');
        } catch {
            showToast('Failed to send ticket', 'error');
        } finally {
            setEmailingId(null);
        }
    };

    if (!isLoaded) {
        return (
            <div className="min-h-screen flex items-center justify-center text-zinc-400">
                <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading…
            </div>
        );
    }

    if (!isSignedIn) {
        return (
            <div className="min-h-screen flex items-center justify-center px-4">
                <div className="max-w-md w-full bg-zinc-900/80 border border-zinc-800 rounded-2xl p-8 text-center">
                    <Ticket className="w-10 h-10 text-red-500 mx-auto mb-3" />
                    <h1 className="text-xl font-bold text-white mb-1">Sign in to see your tickets</h1>
                    <p className="text-zinc-400 text-sm mb-5">Your bookings, receipts, and QR codes — all in one place.</p>
                    <Link
                        href="/login?redirect=/me/tickets"
                        className="interactive-control inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white font-medium"
                    >
                        Sign in <ArrowRight className="w-4 h-4" />
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen px-4 sm:px-6 lg:px-8 py-10 max-w-5xl mx-auto">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
                <div>
                    <p className="text-xs uppercase tracking-widest text-zinc-500 mb-1">Your account</p>
                    <h1 className="text-2xl sm:text-3xl font-bold text-white">My Tickets</h1>
                    <p className="text-zinc-400 text-sm mt-1">
                        Welcome back{user?.firstName ? `, ${user.firstName}` : ''}. Here are your bookings.
                    </p>
                </div>
                <div className="inline-flex bg-zinc-900 border border-zinc-800 rounded-xl p-1 text-sm">
                    {(['upcoming', 'past', 'all'] as const).map((f) => (
                        <button
                            key={f}
                            onClick={() => setFilter(f)}
                            className={`px-3 py-1.5 rounded-lg capitalize ${filter === f ? 'bg-red-600 text-white' : 'text-zinc-300 hover:text-white'}`}
                        >
                            {f}
                        </button>
                    ))}
                </div>
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-20 text-zinc-400">
                    <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading tickets…
                </div>
            ) : filtered.length === 0 ? (
                <div className="bg-zinc-900/60 border border-dashed border-zinc-700 rounded-2xl p-12 text-center">
                    <Ticket className="w-12 h-12 text-zinc-500 mx-auto mb-3" />
                    <h2 className="text-lg font-semibold text-white mb-1">No tickets here yet</h2>
                    <p className="text-zinc-400 text-sm mb-5">
                        {filter === 'upcoming' ? 'Browse upcoming events and grab a spot.' : filter === 'past' ? 'No past tickets to show.' : 'Browse events to book your first ticket.'}
                    </p>
                    <Link
                        href="/discover"
                        className="interactive-control inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-medium"
                    >
                        Discover events <ArrowRight className="w-4 h-4" />
                    </Link>
                </div>
            ) : (
                <ul className="space-y-3">
                    {filtered.map((t) => (
                        <li key={t.id} className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row gap-4">
                            <div className="flex items-start gap-4 flex-1 min-w-0">
                                <div className="w-14 h-14 rounded-xl bg-red-600/20 text-red-500 flex items-center justify-center shrink-0">
                                    <Ticket className="w-6 h-6" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2 mb-1">
                                        <h3 className="text-white font-semibold truncate">{t.event?.name || 'Event'}</h3>
                                        <StatusPill status={t.lifecycleStatus} />
                                    </div>
                                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400">
                                        {t.event?.date && (
                                            <span className="flex items-center gap-1">
                                                <Calendar className="w-3 h-3" />
                                                {new Date(t.event.date).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                                            </span>
                                        )}
                                        {t.event?.venue && (
                                            <span className="flex items-center gap-1">
                                                <MapPin className="w-3 h-3" />
                                                {t.event.venue}
                                            </span>
                                        )}
                                        <span>{money(t.netAmount)}</span>
                                        {t.ticketType?.name && <span>{t.ticketType.name}</span>}
                                    </div>
                                </div>
                            </div>
                            <div className="flex sm:flex-col gap-2 sm:items-end sm:justify-center shrink-0">
                                <Link
                                    href={`/ticket/${t.id}`}
                                    className="interactive-control px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white text-sm flex items-center gap-1.5"
                                >
                                    View ticket <ArrowRight className="w-3.5 h-3.5" />
                                </Link>
                                {['paid', 'checked_in', 'partially_refunded', 'refunded'].includes(t.lifecycleStatus) && <a href={`/api/me/tickets/${encodeURIComponent(t.id)}/invoice`} className="interactive-control px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white text-sm flex items-center gap-1.5"><Download className="w-3.5 h-3.5" /> Receipt</a>}
                                {t.lifecycleStatus !== 'refunded' && t.lifecycleStatus !== 'cancelled' && (
                                    <button
                                        onClick={() => resendTicket(t.id)}
                                        disabled={emailingId === t.id}
                                        className="px-3 py-1.5 rounded-lg bg-blue-600/20 text-blue-300 border border-blue-500/30 hover:bg-blue-600/30 text-sm flex items-center gap-1.5 disabled:opacity-50"
                                    >
                                        {emailingId === t.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                                        Email me
                                    </button>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            <div className="mt-6 text-center text-xs text-zinc-500">
                Can&apos;t find a ticket? <Link href="/ticket" className="underline hover:text-zinc-300">Look up by ID</Link>.
            </div>
        </div>
    );
}
