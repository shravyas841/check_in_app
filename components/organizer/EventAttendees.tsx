'use client';

import { useState, useEffect } from 'react';
import {Search, Download, Copy, Mail, Phone, User, Calendar, Send, ReceiptText, CheckSquare, Square, X, Loader2, Shield} from '@/components/icons';
import { useToast } from '@/components/Toaster';
import TicketActions from '@/components/TicketActions';
import type { RegistrationField } from '@/lib/registration-forms';

interface Ticket {
    id: string;
    name: string;
    email?: string | null;
    phone?: string | null;
    status: string;
    lifecycleStatus?: string;
    checkedIn: boolean;
    amountPaid?: number;
    grossAmount?: number;
    discountAmount?: number;
    refundedAmount?: number;
    lastDeliveredAt?: string | null;
    deliveryCount?: number;
    deliveryHistory?: { id: string; channel: string; success: boolean; createdAt: string; error?: string | null }[];
    createdAt: string;
    customAnswers?: Record<string, string | boolean>;
    event?: { registrationFields?: RegistrationField[] };
}

interface EventAttendeesProps {
    eventId: string;
    onClose: () => void;
}

export default function EventAttendees({ eventId }: EventAttendeesProps) {
    const { showToast } = useToast();
    const [tickets, setTickets] = useState<Ticket[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [resendingId, setResendingId] = useState<string | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [bulkRunning, setBulkRunning] = useState(false);
    const [cursor, setCursor] = useState<string | null>(null);
    const [cursorHistory, setCursorHistory] = useState<string[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [expandedAnswersId, setExpandedAnswersId] = useState<string | null>(null);

    const toggleSelect = (id: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };
    const toggleSelectAllFiltered = () => {
        const visible = filteredTickets.map((t) => t.id);
        const allSelected = visible.length > 0 && visible.every((id) => selected.has(id));
        setSelected((prev) => {
            const next = new Set(prev);
            if (allSelected) {
                visible.forEach((id) => next.delete(id));
            } else {
                visible.forEach((id) => next.add(id));
            }
            return next;
        });
    };
    const clearSelection = () => setSelected(new Set());

    const handleBulk = async (action: 'resend' | 'cancel') => {
        const ids = Array.from(selected);
        if (ids.length === 0) return;
        setBulkRunning(true);
        try {
            const res = await fetch('/api/tickets/bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticketIds: ids, action }),
            });
            const data = await res.json();
            if (res.ok) {
                const failed = (data.failed as number) ?? 0;
                if (failed > 0) {
                    const firstError = (data.results as Array<{ id: string; ok: boolean; error?: string }>).find((r) => !r.ok)?.error;
                    showToast(`${data.succeeded} succeeded, ${failed} failed${firstError ? ` (e.g. ${firstError})` : ''}`, 'error');
                } else {
                    showToast(`${data.succeeded} ${action === 'resend' ? 'resent' : 'cancelled'} successfully`, 'success');
                }
                clearSelection();
                await fetchTickets();
            } else {
                showToast(data.error || 'Bulk action failed', 'error');
            }
        } catch {
            showToast('Bulk action failed', 'error');
        } finally {
            setBulkRunning(false);
        }
    };

    useEffect(() => {
        const timer = window.setTimeout(() => void fetchTickets(), 250);
        return () => window.clearTimeout(timer);
    }, [eventId, cursor, searchTerm, statusFilter]);

    const fetchTickets = async () => {
        setLoading(true);
        setError('');
        try {
            const params = new URLSearchParams({ eventId, pageSize: '25' });
            if (cursor) params.set('cursor', cursor);
            if (searchTerm.trim()) params.set('q', searchTerm.trim());
            if (statusFilter !== 'all') params.set('status', statusFilter);
            const res = await fetch(`/api/tickets?${params}`, { cache: 'no-store' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to load attendees');
            setTickets(data.items || []);
            setNextCursor(data.pagination?.nextCursor || null);
            setSelected(new Set());
        } catch (error) {
            console.error('Failed to fetch tickets:', error);
            setError(error instanceof Error ? error.message : 'Failed to load attendees');
        } finally {
            setLoading(false);
        }
    };

    const filteredTickets = tickets;

    const formatMoney = (amount = 0) => new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0,
    }).format(amount / 100);

    const getStatusClass = (ticket: Ticket) => {
        const lifecycle = ticket.lifecycleStatus || (ticket.checkedIn ? 'checked_in' : ticket.status);
        if (lifecycle === 'checked_in' || ticket.status === 'paid') return 'bg-green-500/10 text-green-500 border border-green-500/20';
        if (ticket.status === 'partially_refunded') return 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20';
        if (ticket.status === 'refunded') return 'bg-red-500/10 text-red-400 border border-red-500/20';
        return 'bg-yellow-500/10 text-yellow-500 border border-yellow-500/20';
    };

    const handleResend = async (ticket: Ticket) => {
        setResendingId(ticket.id);
        try {
            const res = await fetch('/api/tickets/deliver', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticketId: ticket.id, sendEmail: true, sendSMS: false }),
            });
            const data = await res.json();
            if (res.ok && data.success) {
                showToast('Ticket resend queued', 'success');
                await fetchTickets();
            } else {
                showToast(data.error || 'Failed to resend ticket', 'error');
            }
        } catch {
            showToast('Failed to resend ticket', 'error');
        } finally {
            setResendingId(null);
        }
    };

    const handleCopyEmails = () => {
        const emails = filteredTickets.map(t => t.email).filter(Boolean).join(', ');
        navigator.clipboard.writeText(emails);
        showToast('Emails copied to clipboard', 'success');
    };

    const handleExport = async () => {
        // Prefer the server endpoint so the CSV is properly escaped and Excel-friendly.
        try {
            const params = new URLSearchParams();
            if (statusFilter && statusFilter !== 'all') params.set('status', statusFilter);
            const res = await fetch(`/api/events/${eventId}/export?${params.toString()}`);
            if (!res.ok) throw new Error('Server export failed');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `attendees-${eventId}.csv`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('Attendees exported', 'success');
        } catch {
            // Fallback: client-side CSV (filtered view, no extra columns)
            const headers = ['ID', 'Name', 'Email', 'Phone', 'Status', 'Registered At'];
            const rows = filteredTickets.map(t => [
                t.id,
                t.name,
                t.email || '',
                t.phone || '',
                t.lifecycleStatus || t.status,
                new Date(t.createdAt).toLocaleString()
            ]);
            const esc = (v: unknown) => {
                const s = String(v ?? '');
                return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const csv = '\uFEFF' + [headers, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `attendees-${eventId}.csv`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('Attendees exported (client-side)', 'success');
        }
    };

    if (loading && tickets.length === 0) return (
        <div className="text-center py-10 text-[#737373]">
            <div className="w-8 h-8 border-2 border-[#E11D2E] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            Loading attendees...
        </div>
    );

    if (error && tickets.length === 0) return <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center text-red-200"><p>{error}</p><button onClick={fetchTickets} className="mt-3 rounded-lg bg-red-500 px-3 py-2 text-sm text-white">Retry</button></div>;

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="flex flex-col sm:flex-row gap-3">
                {/* Search */}
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#737373]" />
                    <input
                        type="text"
                        placeholder="Search attendees..."
                        value={searchTerm}
                        onChange={(e) => { setSearchTerm(e.target.value); setCursor(null); setCursorHistory([]); }}
                        className="w-full pl-10 pr-4 py-2.5 bg-[#1A1A1A] border border-[#1F1F1F] rounded-xl text-white placeholder-[#737373] focus:outline-none focus:border-[#E11D2E]"
                    />
                </div>
                <select
                    value={statusFilter}
                    onChange={(event) => { setStatusFilter(event.target.value); setCursor(null); setCursorHistory([]); }}
                    className="px-3 py-2.5 bg-[#1A1A1A] border border-[#1F1F1F] rounded-xl text-white focus:outline-none focus:border-[#E11D2E] text-sm"
                >
                    <option value="all">All statuses</option>
                    <option value="pending">Pending</option>
                    <option value="paid">Paid</option>
                    <option value="partially_refunded">Partial refund</option>
                    <option value="refunded">Refunded</option>
                    <option value="checked_in">Checked in</option>
                </select>
                {/* Actions */}
                <div className="flex gap-2">
                    <button
                        onClick={handleCopyEmails}
                        className="px-4 py-2.5 bg-[#1A1A1A] border border-[#1F1F1F] text-[#B3B3B3] rounded-xl hover:bg-[#222] hover:text-white transition-colors flex items-center gap-2 text-sm"
                    >
                        <Copy className="w-4 h-4" /> Copy Emails
                    </button>
                    <button
                        onClick={handleExport}
                        className="px-4 py-2.5 bg-[#E11D2E]/20 text-[#E11D2E] border border-[#E11D2E]/30 rounded-xl hover:bg-[#E11D2E]/30 transition-colors flex items-center gap-2 text-sm"
                    >
                        <Download className="w-4 h-4" /> Export
                    </button>
                </div>
            </div>

            {/* Bulk action bar */}
            {selected.size > 0 && (
                <div className="flex items-center justify-between gap-2 p-3 bg-red-600/10 border border-red-500/30 rounded-xl text-sm">
                    <div className="flex items-center gap-2 text-white">
                        <Shield className="w-4 h-4 text-red-400" />
                        <span><span className="font-semibold">{selected.size}</span> selected</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => handleBulk('resend')}
                            disabled={bulkRunning}
                            className="px-3 py-1.5 rounded-lg bg-blue-600/20 text-blue-300 border border-blue-500/30 hover:bg-blue-600/30 text-xs flex items-center gap-1 disabled:opacity-50"
                        >
                            {bulkRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                            Resend
                        </button>
                        <button
                            onClick={() => handleBulk('cancel')}
                            disabled={bulkRunning}
                            className="px-3 py-1.5 rounded-lg bg-yellow-600/20 text-yellow-300 border border-yellow-500/30 hover:bg-yellow-600/30 text-xs flex items-center gap-1 disabled:opacity-50"
                        >
                            <X className="w-3 h-3" />
                            Cancel pending
                        </button>
                        <button
                            onClick={clearSelection}
                            className="px-3 py-1.5 rounded-lg text-zinc-400 hover:text-white text-xs"
                        >
                            Clear
                        </button>
                    </div>
                </div>
            )}

            {/* Attendee List */}
            <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                {filteredTickets.length > 0 && (
                    <label className="flex items-center gap-2 text-xs text-zinc-400 select-none cursor-pointer px-1">
                        <button
                            type="button"
                            onClick={toggleSelectAllFiltered}
                            className="text-zinc-300 hover:text-white"
                            aria-label={filteredTickets.every((t) => selected.has(t.id)) && filteredTickets.length > 0 ? 'Deselect all' : 'Select all'}
                        >
                            {filteredTickets.every((t) => selected.has(t.id)) && filteredTickets.length > 0
                                ? <CheckSquare className="w-4 h-4 text-red-400" />
                                : <Square className="w-4 h-4" />}
                        </button>
                        Select all {filteredTickets.length} on this page
                    </label>
                )}
                {filteredTickets.length === 0 ? (
                    <div className="text-center py-12 bg-[#1A1A1A] rounded-xl border border-dashed border-[#1F1F1F]">
                        <User className="w-10 h-10 text-[#737373] mx-auto mb-3" />
                        <p className="text-[#737373]">No attendees found.</p>
                    </div>
                ) : (
                    filteredTickets.map(ticket => (
                        <div key={ticket.id} className={`p-4 bg-[#1A1A1A] border rounded-xl transition-colors ${selected.has(ticket.id) ? 'border-red-500/50 bg-red-500/5' : 'border-[#1F1F1F] hover:border-[#E11D2E]/30'}`}>
                            <div className="flex items-start justify-between gap-3">
                                {/* Checkbox + Avatar + Info */}
                                <div className="flex items-start gap-3 min-w-0 flex-1">
                                    <button
                                        type="button"
                                        onClick={() => toggleSelect(ticket.id)}
                                        aria-label={selected.has(ticket.id) ? 'Deselect' : 'Select'}
                                        className="mt-2 text-zinc-300 hover:text-white"
                                    >
                                        {selected.has(ticket.id)
                                            ? <CheckSquare className="w-4 h-4 text-red-400" />
                                            : <Square className="w-4 h-4" />}
                                    </button>
                                    <div className="w-10 h-10 rounded-full bg-[#E11D2E]/20 flex items-center justify-center text-[#E11D2E] font-bold flex-shrink-0">
                                        {ticket.name?.charAt(0).toUpperCase() || '?'}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <h4 className="text-white font-medium truncate">{ticket.name}</h4>
                                        <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 text-xs text-[#737373] mt-1">
                                            {ticket.email && (
                                                <span className="flex items-center gap-1 truncate">
                                                    <Mail className="w-3 h-3 flex-shrink-0" />
                                                    <span className="truncate">{ticket.email}</span>
                                                </span>
                                            )}
                                            {ticket.phone && (
                                                <span className="flex items-center gap-1">
                                                    <Phone className="w-3 h-3 flex-shrink-0" />
                                                    {ticket.phone}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                                {/* Status + Date */}
                                <div className="flex flex-col items-end gap-2 flex-shrink-0">
                                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getStatusClass(ticket)}`}>
                                        {(ticket.lifecycleStatus || ticket.status)?.replace(/_/g, ' ').toUpperCase()}
                                    </span>
                                    <span className="text-[10px] text-[#737373] flex items-center gap-1">
                                        <Calendar className="w-3 h-3" />
                                        {new Date(ticket.createdAt).toLocaleDateString()}
                                    </span>
                                </div>
                            </div>
                            {ticket.customAnswers && Object.keys(ticket.customAnswers).length > 0 && (
                                <div className="mt-3 border-t border-[#1F1F1F] pt-3">
                                    <button
                                        type="button"
                                        onClick={() => setExpandedAnswersId((current) => current === ticket.id ? null : ticket.id)}
                                        className="text-xs text-[#FF6B7A] hover:text-white"
                                        aria-expanded={expandedAnswersId === ticket.id}
                                    >
                                        {expandedAnswersId === ticket.id ? 'Hide' : 'View'} registration answers
                                    </button>
                                    {expandedAnswersId === ticket.id && (
                                        <div className="mt-2 grid gap-2 sm:grid-cols-2 text-xs">
                                            {Object.entries(ticket.customAnswers).map(([fieldId, value]) => {
                                                const field = ticket.event?.registrationFields?.find((item) => item.id === fieldId);
                                                return (
                                                    <div key={fieldId} className="rounded-lg bg-[#0D0D0D] border border-[#1F1F1F] px-3 py-2">
                                                        <span className="block text-[#737373]">{field?.label || fieldId}</span>
                                                        <span className="text-white">{typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value || '—'}</span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            )}
                            <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto] border-t border-[#1F1F1F] pt-3">
                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                                    <div className="flex items-center gap-1 text-[#737373]">
                                        <ReceiptText className="w-3 h-3" />
                                        Paid <span className="text-white">{formatMoney(ticket.amountPaid)}</span>
                                    </div>
                                    <div className="text-[#737373]">Discount <span className="text-white">{formatMoney(ticket.discountAmount)}</span></div>
                                    <div className="text-[#737373]">Refunded <span className="text-white">{formatMoney(ticket.refundedAmount)}</span></div>
                                    <div className="text-[#737373]">
                                        Sent <span className="text-white">{ticket.deliveryCount || 0}</span>
                                        {ticket.lastDeliveredAt ? <span className="ml-1">({new Date(ticket.lastDeliveredAt).toLocaleDateString()})</span> : null}
                                    </div>
                                </div>
                                {ticket.deliveryHistory && ticket.deliveryHistory.length > 0 && (
                                    <div className="mt-2 text-[11px] text-[#737373] lg:col-span-2">
                                        Last resend: {ticket.deliveryHistory[0].channel} {ticket.deliveryHistory[0].success ? 'sent' : 'failed'} on {new Date(ticket.deliveryHistory[0].createdAt).toLocaleString()}
                                    </div>
                                )}
                                <div className="flex flex-wrap gap-2 justify-start lg:justify-end">
                                    <button
                                        onClick={() => handleResend(ticket)}
                                        disabled={resendingId === ticket.id || !ticket.email || !['paid', 'partially_refunded'].includes(ticket.status)}
                                        className="px-3 py-1.5 bg-[#E11D2E]/10 text-[#FF6B7A] border border-[#E11D2E]/30 rounded-lg hover:bg-[#E11D2E]/20 disabled:opacity-50 text-sm flex items-center gap-1"
                                    >
                                        <Send className="w-3.5 h-3.5" />
                                        {resendingId === ticket.id ? 'Sending...' : 'Resend'}
                                    </button>
                                    <TicketActions
                                        ticketId={ticket.id}
                                        ticketStatus={ticket.status}
                                        isCheckedIn={ticket.checkedIn}
                                        attendeeName={ticket.name}
                                        attendeeEmail={ticket.email}
                                        onActionComplete={fetchTickets}
                                    />
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* Footer Stats */}
            <div className="pt-3 border-t border-[#1F1F1F] flex flex-wrap items-center justify-between gap-3 text-sm text-[#737373]">
                <span>Showing {tickets.length} attendees · Cursor pagination</span>
                <div className="flex gap-2"><button disabled={cursorHistory.length === 0 || loading} onClick={() => { const history = [...cursorHistory]; const previous = history.pop() || null; setCursorHistory(history); setCursor(previous); }} className="rounded-lg border border-[#333] px-3 py-1.5 disabled:opacity-40">Previous</button><button disabled={!nextCursor || loading} onClick={() => { if (nextCursor) { setCursorHistory((history) => [...history, cursor || '']); setCursor(nextCursor); } }} className="rounded-lg border border-[#333] px-3 py-1.5 disabled:opacity-40">Next</button></div>
            </div>
        </div>
    );
}
