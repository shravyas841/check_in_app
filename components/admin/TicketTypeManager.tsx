'use client';

import { useCallback, useEffect, useState } from 'react';
import { readJsonResponse } from '@/lib/client-response';

type EventOption = { id: string; name: string };
type TicketType = { id: string; name: string; description?: string | null; price: number; capacity: number; soldCount: number; active: boolean; minPerOrder: number; maxPerOrder: number };

export default function TicketTypeManager({ events }: { events: EventOption[] }) {
  const [eventId, setEventId] = useState(events[0]?.id || '');
  const [items, setItems] = useState<TicketType[]>([]);
  const [name, setName] = useState(''); const [price, setPrice] = useState('0'); const [capacity, setCapacity] = useState('100');
  const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!eventId) return; setLoading(true); setError('');
    try { const response = await fetch(`/api/admin/ticket-types?eventId=${encodeURIComponent(eventId)}`, { cache: 'no-store' }); const body = await readJsonResponse<{ items?: TicketType[]; error?: string }>(response, 'Unable to load ticket types'); if (!response.ok) throw new Error(body.error); setItems(body.items || []); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load ticket types'); } finally { setLoading(false); }
  }, [eventId]);
  useEffect(() => { void load(); }, [load]);
  const create = async () => {
    setError('');
    try { const response = await fetch('/api/admin/ticket-types', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId, name, price: Math.round(Number(price) * 100), capacity: Number(capacity), minPerOrder: 1, maxPerOrder: 10, active: true, sortOrder: items.length }) }); const body = await readJsonResponse<{ error?: string }>(response, 'Unable to create ticket type'); if (!response.ok) throw new Error(body.error); setName(''); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to create ticket type'); }
  };
  const toggle = async (item: TicketType) => {
    const response = await fetch('/api/admin/ticket-types', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...item, eventId, description: item.description || undefined, active: !item.active }) });
    if (response.ok) await load(); else setError((await readJsonResponse<{ error?: string }>(response, 'Unable to update ticket type')).error || 'Unable to update ticket type');
  };
  return <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-6"><div><h3 className="text-lg font-semibold text-white">Ticket types and inventory</h3><p className="text-sm text-zinc-500">Admin-only pricing and capacity controls. Existing event-level tickets remain supported.</p></div><select value={eventId} onChange={(event) => setEventId(event.target.value)} className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-3 text-white">{events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}</select>{error && <div className="rounded-lg border border-red-800 bg-red-950/40 p-3 text-sm text-red-300">{error}<button className="ml-3 underline" onClick={() => void load()}>Retry</button></div>}<div className="grid gap-3 md:grid-cols-4"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Type name" className="rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-3 text-white"/><input value={price} onChange={(event) => setPrice(event.target.value)} type="number" min="0" step="0.01" placeholder="Price in INR" className="rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-3 text-white"/><input value={capacity} onChange={(event) => setCapacity(event.target.value)} type="number" min="1" placeholder="Capacity" className="rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-3 text-white"/><button disabled={!name.trim() || !eventId} onClick={() => void create()} className="rounded-xl bg-yellow-300 px-4 py-3 font-semibold text-black disabled:opacity-40">Add ticket type</button></div>{loading && !items.length ? <p className="text-sm text-zinc-500">Loading ticket types…</p> : !items.length ? <p className="rounded-xl border border-dashed border-zinc-700 p-6 text-center text-sm text-zinc-500">No ticket types. Registration uses the event’s existing price and capacity.</p> : <div className="grid gap-3 md:grid-cols-2">{items.map((item) => <article key={item.id} className="rounded-xl border border-zinc-800 bg-zinc-950 p-4"><div className="flex justify-between gap-4"><div><p className="font-semibold text-white">{item.name}</p><p className="text-sm text-zinc-500">₹{(item.price / 100).toFixed(2)} · {item.soldCount}/{item.capacity} sold</p></div><button onClick={() => void toggle(item)} className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300">{item.active ? 'Pause' : 'Activate'}</button></div></article>)}</div>}</section>;
}
