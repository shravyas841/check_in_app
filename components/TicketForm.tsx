'use client';

import { useApp, Event as StoreEvent } from '@/lib/store';
import { useCallback, useState, useEffect } from 'react';
import { useToast } from './Toaster';

type Event = StoreEvent & { currentPrice?: number }; // allow optional dynamic price while keeping core shape
type TicketType = { id: string; name: string; description?: string | null; price: number; capacity: number; soldCount: number; minPerOrder: number; maxPerOrder: number; availability: { available: boolean; remaining: number; reason: string | null } };

declare global {
  interface Window {
    Razorpay: any;
  }
}

const RAZORPAY_SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

function loadRazorpayScript() {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_SCRIPT_SRC}"]`);
    const script = existingScript || document.createElement('script');
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve(Boolean(window.Razorpay));
    }, 8000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      script.removeEventListener('load', handleLoad);
      script.removeEventListener('error', handleError);
    };
    const handleLoad = () => {
      cleanup();
      resolve(Boolean(window.Razorpay));
    };
    const handleError = () => {
      cleanup();
      resolve(false);
    };

    script.addEventListener('load', handleLoad);
    script.addEventListener('error', handleError);

    if (!existingScript) {
      script.src = RAZORPAY_SCRIPT_SRC;
      script.async = true;
      document.body.appendChild(script);
    }
  });
}

export default function TicketForm() {
  const { siteSettings } = useApp();
  const [events, setEvents] = useState<Event[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<string>('');
  const [ticketTypes, setTicketTypes] = useState<TicketType[]>([]);
  const [selectedTicketType, setSelectedTicketType] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [attendees, setAttendees] = useState<{ name: string; email: string; phone: string }[]>([{ name: '', email: '', phone: '' }]);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
  });
  const [answers, setAnswers] = useState<Record<string, string>>({}); // { fieldId: answer }
  const [promoCode, setPromoCode] = useState('');
  const [discount, setDiscount] = useState<{ amount: number; type: 'percentage' | 'fixed'; code: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [applyingPromo, setApplyingPromo] = useState(false);
  const { showToast } = useToast();



  const MAX_TICKETS = 10;



  // Update attendees array when quantity changes
  const handleQuantityChange = (newQty: number) => {
    const qty = Math.max(1, Math.min(MAX_TICKETS, newQty));
    if (qty !== quantity && discount) {
      setDiscount(null);
      setPromoCode('');
    }
    setQuantity(qty);

    const newAttendees = [...attendees];
    while (newAttendees.length < qty) {
      newAttendees.push({ name: '', email: '', phone: '' });
    }
    while (newAttendees.length > qty) {
      newAttendees.pop();
    }
    setAttendees(newAttendees);
  };

  // Update single attendee
  const updateAttendee = (index: number, field: 'name' | 'email' | 'phone', value: string) => {
    const newAttendees = [...attendees];
    newAttendees[index] = { ...newAttendees[index], [field]: value };
    setAttendees(newAttendees);

    // Keep formData in sync with first attendee for payment prefill
    if (index === 0) {
      setFormData(prev => ({ ...prev, [field]: value }));
    }
  };

  const getUnitPrice = (event?: Event) => {
    if (!event) return 0;
    const ticketType = ticketTypes.find((item) => item.id === selectedTicketType);
    if (ticketType) return ticketType.price;

    if (event.earlyBirdEnabled &&
      event.earlyBirdDeadline &&
      new Date(event.earlyBirdDeadline) > new Date()) {
      return event.earlyBirdPrice || event.price;
    }

    return event.currentPrice !== undefined ? event.currentPrice : event.price;
  };

  // Calculate total price
  const calculateTotalPrice = () => {
    if (!selectedEventData) return 0;
    let total = getUnitPrice(selectedEventData) * quantity;

    // Apply Discount
    if (discount) {
      if (discount.type === 'percentage') {
        total = total - (total * (discount.amount / 100));
      } else {
        total = Math.max(0, total - discount.amount);
      }
    }

    return Math.round(total);
  };

  const handleApplyPromo = async () => {
    const code = promoCode.trim().toUpperCase();
    if (!code) return;
    if (!selectedEvent) {
      showToast('Please select an event first', 'error');
      return;
    }

    setApplyingPromo(true);
    try {
      const res = await fetch('/api/promo/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          eventId: selectedEvent,
          quantity,
          userEmail: attendees[0]?.email || formData.email,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.valid) {
        showToast(data.error || 'Invalid or expired promo code', 'error');
        return;
      }

      setDiscount({
        amount: data.promo.discountValue,
        type: data.promo.discountType,
        code: data.promo.code,
      });
      setPromoCode(data.promo.code);
      showToast('Promo code applied!', 'success');
    } catch {
      showToast('Failed to validate promo code', 'error');
    } finally {
      setApplyingPromo(false);
    }
  };

  const fetchEvents = useCallback(async () => {
    try {
      const response = await fetch('/api/events');
      if (response.ok) {
        const data = await response.json();
        let fetchedEvents: Event[] = [];

        if (Array.isArray(data)) {
          fetchedEvents = data;
        } else if (data.events) {
          fetchedEvents = data.events;
        }

        setEvents(fetchedEvents);

        // Auto-select event logic
        if (fetchedEvents.length > 0) {
          const preSelected = localStorage.getItem('selectedEventId');
          if (preSelected) {
            const exists = fetchedEvents.find((e) => e.id === preSelected);
            if (exists) {
              setSelectedEvent(preSelected);
              localStorage.removeItem('selectedEventId');
            } else {
              setSelectedEvent(fetchedEvents[0].id);
            }
          } else {
            setSelectedEvent(fetchedEvents[0].id);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load events', error);
      showToast('Failed to load events', 'error');
    } finally {
      setLoadingEvents(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadRazorpayScript();
    fetchEvents();
  }, [fetchEvents]);

  useEffect(() => {
    if (!selectedEvent) { setTicketTypes([]); setSelectedTicketType(''); return; }
    let active = true;
    fetch(`/api/events/${encodeURIComponent(selectedEvent)}/ticket-types`, { cache: 'no-store' })
      .then(async (response) => response.ok ? response.json() : { items: [] })
      .then((body) => { if (!active) return; const items = body.items || []; setTicketTypes(items); setSelectedTicketType(items.find((item: TicketType) => item.availability.available)?.id || ''); })
      .catch(() => { if (active) { setTicketTypes([]); setSelectedTicketType(''); } });
    return () => { active = false; };
  }, [selectedEvent]);

  const selectedEventData = events.find(e => e.id === selectedEvent);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEvent) {
      showToast('Please select an event', 'error');
      return;
    }

    // Validate all attendee names are filled
    const invalidAttendee = attendees.find((a, i) => !a.name.trim());
    if (invalidAttendee !== undefined) {
      showToast('Please enter names for all ticket holders', 'error');
      return;
    }

    // Validate Required Custom Questions
    const selectedEvt = events.find(e => e.id === selectedEvent);
    if (!selectedEvt) {
      showToast('Event not found', 'error');
      return;
    }

    if (!selectedEvt.isActive) {
      showToast('Ticket sales are paused for this event', 'error');
      return;
    }

    if (selectedEvt.registrationFields) {
      for (const field of selectedEvt.registrationFields) {
        if (field.required && (!answers[field.id] || !answers[field.id].trim())) {
          showToast(`Please answer the required question: "${field.label}"`, 'error');
          return;
        }
      }
    }

    setLoading(true);

    try {
      if (calculateTotalPrice() > 0) {
        const razorpayReady = await loadRazorpayScript();
        if (!razorpayReady) {
          throw new Error('Payment checkout could not be loaded. Please check your connection and try again.');
        }
      }

      // Create tickets for all attendees
      const ticketRes = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: selectedEvent,
          ticketTypeId: selectedTicketType || undefined,
          quantity,
          attendees: attendees.map(a => ({
            name: a.name,
            email: a.email || formData.email,
            phone: a.phone || formData.phone,
          })),
          name: attendees[0].name,
          email: attendees[0].email || formData.email,
          phone: attendees[0].phone || formData.phone,
          customAnswers: answers // Pass custom answers
        }),
      });


      if (!ticketRes.ok) {
        const errorText = await ticketRes.text();
        try {
          const errorJson = JSON.parse(errorText);
          throw new Error(errorJson.error || 'Failed to create ticket');
        } catch (e) {
          throw new Error(errorText || 'Failed to create ticket');
        }
      }

      const ticketData = await ticketRes.json();

      // Create Razorpay order with total amount
      const orderRes = await fetch('/api/razorpay/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticketId: ticketData.ticketId, // Primary ticket ID
          ticketIds: ticketData.ticketIds, // All ticket IDs for multi-ticket
          quantity,
          promoCode: discount?.code,
        }),
      });

      if (!orderRes.ok) {
        // Special case for payments disabled
        if (orderRes.status === 403) {
          throw new Error('Payments are currently paused. Please try again later.');
        }

        const errorText = await orderRes.text();
        try {
          const errorJson = JSON.parse(errorText);
          throw new Error(errorJson.error || 'Failed to create payment order');
        } catch (e: any) {
          // If we already threw above, rethrow
          if (e.message === 'Failed to create payment order' || e.message === 'Payments are currently paused. Please try again later.') throw e;
          throw new Error(errorText || 'Failed to create payment order');
        }
      }

      const orderData = await orderRes.json();

      if (orderData.freeOrder) {
        showToast('Registration complete!', 'success');
        window.location.href = orderData.ticketUrl || `/ticket/${ticketData.ticketId}?success=true&token=${encodeURIComponent(orderData.token)}`;
        return;
      }

      const razorpayReady = window.Razorpay || await loadRazorpayScript();
      if (!razorpayReady) {
        throw new Error('Payment checkout could not be loaded. Please check your connection and try again.');
      }

      // Open Razorpay checkout
      const options = {
        key: orderData.keyId,
        amount: orderData.amount,
        currency: orderData.currency,
        name: 'Event Ticketing',
        description: ticketData.eventName,
        order_id: orderData.orderId,
        handler: async function (response: any) {
          // Verify payment
          const selectedEvt = events.find(e => e.id === selectedEvent);
          const verifyRes = await fetch('/api/razorpay/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
              ticketId: ticketData.ticketId,
              email: formData.email,
              name: formData.name,
              eventName: selectedEvt?.name || ticketData.eventName,
              eventDate: selectedEvt?.date,
              venue: selectedEvt?.venue,
              // Pass custom styles setting
              emailStyles: {
                bgColor: siteSettings?.ticketBgColor,
                textColor: siteSettings?.ticketTextColor,
                accentColor: siteSettings?.ticketAccentColor,
                gradientColor: siteSettings?.ticketGradientColor,
                fontFamily: siteSettings?.ticketFontFamily,
                borderRadius: siteSettings?.ticketBorderRadius,
                logoUrl: siteSettings?.ticketLogoUrl
              }
            }),
          });

          const verifyData = await verifyRes.json();
          if (verifyRes.ok) {
            if (!verifyData.token && !verifyData.ticketUrl) {
              showToast('Payment verified, but secure ticket access could not be generated. Please contact support.', 'error');
              return;
            }
            showToast('Payment successful! Check your email for ticket.', 'success');
            window.location.href = verifyData.ticketUrl || `/ticket/${ticketData.ticketId}?success=true&token=${encodeURIComponent(verifyData.token)}`;
          } else {
            showToast(verifyData.error || 'Payment verification failed', 'error');
          }
        },
        prefill: {
          name: formData.name,
          email: formData.email,
          contact: formData.phone,
        },
        theme: {
          color: '#E11D2E',
        },
      };

      const razorpay = new window.Razorpay(options);
      razorpay.open();
    } catch (err: any) {
      // Avoid console.error for expected business errors to prevent Next.js overlay
      if (err.message === 'Payments are currently paused. Please try again later.') {
        showToast(err.message, 'error');
        return;
      }

      console.error('Ticket purchase error:', err);
      // Check for fetch/network errors
      if (err.message && (err.message.includes('fetch') || err.message.includes('Network'))) {
        showToast('Connection to server failed. Please try again.', 'error');
      } else {
        showToast(err.message || 'An error occurred', 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  const isEarlyBird = selectedEventData?.earlyBirdEnabled &&
    selectedEventData?.earlyBirdDeadline &&
    new Date(selectedEventData.earlyBirdDeadline) > new Date();

  // Global Sales Pause Check (After hooks)
  if (siteSettings?.globalSalesPaused) {
    return (
      <div className="w-full max-w-2xl mx-auto">
        <div className="glass rounded-2xl shadow-2xl overflow-hidden border border-red-500/30 p-12 text-center">
          <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-10 h-10 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-white mb-3">Sales Temporarily Paused</h2>
          <p className="text-zinc-400 max-w-md mx-auto">
            {siteSettings.maintenanceMessage || "We are currently performing maintenance. Ticket sales will resume shortly. Please check back later."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-2xl mx-auto ticket-form-shell">
      <div className="glass rounded-2xl shadow-2xl overflow-hidden border border-[#1F1F1F]">
        {/* Card Header */}
        <div className="relative overflow-hidden px-8 py-7 ticket-form-header">
          {/* Background gradient */}
          <div className="absolute inset-0 bg-gradient-to-r from-[#E11D2E]/80 to-[#B91C1C]/80" />
          <div className="absolute inset-0 noise-texture" />

          <div className="relative z-10">
            <h2 className="font-heading text-2xl font-bold text-white">Event Registration</h2>
            <p className="text-red-200/80 text-sm mt-1.5">Select your event and complete registration</p>
          </div>
        </div>

        {/* Card Body */}
        <div className="px-8 py-8 space-y-6 ticket-form-body">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Event Selection */}
            <div>
              <label className="block text-sm font-semibold text-[#B3B3B3] mb-3">
                Select Event <span className="text-[#E11D2E]">*</span>
              </label>
              {loadingEvents ? (
                <div className="h-14 bg-[#141414] rounded-[10px] skeleton" />
              ) : events.length === 0 ? (
                <div className="p-5 bg-[#141414] border border-[#1F1F1F] rounded-[10px] text-[#737373] text-center">
                  No events available at the moment
                </div>
              ) : (
                <select
                  value={selectedEvent}
                  onChange={(e) => {
                    setSelectedEvent(e.target.value);
                    setDiscount(null);
                    setPromoCode('');
                  }}
                  className="w-full px-4 py-4 bg-[#0D0D0D] border border-[#2A2A2A] rounded-[10px] focus:outline-none focus:ring-2 focus:ring-[#E11D2E]/50 focus:border-[#E11D2E] text-white transition-all appearance-none cursor-pointer"
                >
                  {events.map((event) => (
                    <option key={event.id} value={event.id}>
                      {event.name} - ₹{(getUnitPrice(event) / 100).toFixed(0)}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {ticketTypes.length > 0 && <div><label className="mb-3 block text-sm font-semibold text-[#B3B3B3]">Ticket type <span className="text-[#E11D2E]">*</span></label><div className="grid gap-3 sm:grid-cols-2">{ticketTypes.map((item) => <button type="button" key={item.id} disabled={!item.availability.available} onClick={() => { setSelectedTicketType(item.id); setDiscount(null); setPromoCode(''); handleQuantityChange(Math.max(item.minPerOrder, Math.min(quantity, item.maxPerOrder))); }} className={`rounded-xl border p-4 text-left transition-colors ${selectedTicketType === item.id ? 'border-yellow-300 bg-yellow-300/10' : 'border-[#2A2A2A] bg-[#0D0D0D]'} disabled:opacity-40`}><span className="block font-semibold text-white">{item.name}</span><span className="mt-1 block text-sm text-[#B3B3B3]">₹{(item.price / 100).toFixed(2)} · {item.availability.remaining} remaining</span></button>)}</div></div>}

            {/* Event Details */}
            {selectedEventData && (
              <div className="bg-[#141414] border border-[#1F1F1F] rounded-xl p-5 ticket-form-section">
                {/* Early Bird Banner */}
                {isEarlyBird && (
                  <div className="mb-4 -mt-1 -mx-1 px-4 py-3 bg-gradient-to-r from-[#22C55E]/15 to-[#16A34A]/15 rounded-lg border border-[#22C55E]/30 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-[#22C55E]/20 flex items-center justify-center">
                        <svg className="w-5 h-5 text-[#22C55E]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-[#22C55E] text-sm font-semibold">Early Bird Discount Active!</p>
                        <p className="text-[#22C55E]/60 text-xs">
                          Ends {new Date(selectedEventData.earlyBirdDeadline!).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                        </p>
                      </div>
                    </div>
                    <span className="px-3 py-1.5 bg-[#22C55E] text-black border border-black rounded-lg text-xs font-bold">
                      Save {Math.round(((selectedEventData.price - (selectedEventData.earlyBirdPrice || 0)) / selectedEventData.price) * 100)}%
                    </span>
                  </div>
                )}

                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <h3 className="font-heading font-semibold text-black text-lg">{selectedEventData.name}</h3>
                    {selectedEventData.description && (
                      <p className="text-sm text-[#B3B3B3] mt-2 line-clamp-2">{selectedEventData.description}</p>
                    )}
                    <div className="flex items-center gap-4 mt-4 text-sm text-[#737373]">
                      {selectedEventData.venue && (
                        <span className="flex items-center gap-1.5">
                          <svg className="w-4 h-4 text-[#E11D2E]/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                          </svg>
                          {selectedEventData.venue}
                        </span>
                      )}
                      <span className="flex items-center gap-1.5">
                        <svg className="w-4 h-4 text-[#E11D2E]/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        {new Date(selectedEventData.date).toLocaleDateString('en-IN', {
                          weekday: 'short',
                          day: 'numeric',
                          month: 'short',
                        })}
                      </span>
                    </div>
                  </div>

                  {/* Price Display */}
                  <div className="text-right flex-shrink-0">
                    {isEarlyBird ? (
                      <>
                        <p className="font-mono text-2xl font-bold text-[#22C55E]">₹{((selectedEventData.earlyBirdPrice || 0) / 100).toFixed(0)}</p>
                        <p className="font-mono text-sm text-[#737373] line-through">₹{(selectedEventData.price / 100).toFixed(0)}</p>
                      </>
                    ) : (
                      <p className="font-mono text-2xl font-bold text-black">₹{(getUnitPrice(selectedEventData) / 100).toFixed(0)}</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Quantity Selector - Enhanced */}
            {selectedEventData && (
              <div className="bg-[#141414] border border-[#1F1F1F] rounded-xl p-5 ticket-form-section">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="block text-sm font-semibold text-[#B3B3B3] mb-1">
                      Number of Tickets
                    </label>
                    <p className="text-xs text-[#737373]">Max {MAX_TICKETS} tickets per order</p>
                  </div>

                  {/* Counter */}
                  <div className="flex items-center gap-4">
                    <button
                      type="button"
                      onClick={() => handleQuantityChange(quantity - 1)}
                      disabled={quantity <= 1}
                      className="w-12 h-12 rounded-xl bg-[#0D0D0D] border border-[#2A2A2A] hover:bg-[#1A1A1A] hover:border-[#E11D2E]/30 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center text-white text-2xl font-bold transition-all"
                    >
                      −
                    </button>
                    <span className="w-14 text-center font-mono text-3xl font-bold text-black">{quantity}</span>
                    <button
                      type="button"
                      onClick={() => handleQuantityChange(quantity + 1)}
                      disabled={quantity >= MAX_TICKETS}
                      className="w-12 h-12 rounded-xl bg-[#0D0D0D] border border-[#2A2A2A] hover:bg-[#1A1A1A] hover:border-[#E11D2E]/30 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center text-white text-2xl font-bold transition-all"
                    >
                      +
                    </button>
                  </div>
                </div>

                {/* Total Price Display */}
                <div className="mt-5 pt-5 border-t border-[#1F1F1F] flex items-center justify-between">
                  <span className="text-[#B3B3B3] font-medium">Total Amount:</span>
                  <span className="font-mono text-3xl font-bold text-black">₹{(calculateTotalPrice() / 100).toLocaleString()}</span>
                </div>
              </div>
            )}

            {/* Promo Code Section */}
            {selectedEventData && (
              <div className="bg-[#141414] border border-[#1F1F1F] rounded-xl p-5 ticket-form-section">
                <label className="block text-sm font-semibold text-[#B3B3B3] mb-3">
                  Promo Code
                </label>
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={promoCode}
                    onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                    placeholder="ENTER CODE"
                    disabled={!!discount}
                    className="flex-1 px-4 py-3 bg-[#0D0D0D] border border-[#2A2A2A] rounded-[10px] focus:outline-none focus:ring-2 focus:ring-[#E11D2E]/50 focus:border-[#E11D2E] text-white placeholder-[#737373] uppercase font-mono tracking-wider disabled:opacity-50"
                  />
                  {discount ? (
                    <button
                      type="button"
                      onClick={() => {
                        setDiscount(null);
                        setPromoCode('');
                        showToast('Promo code removed', 'success');
                      }}
                      className="px-6 py-3 bg-zinc-800 text-zinc-400 hover:text-white rounded-[10px] border border-zinc-700 hover:bg-zinc-700 font-medium transition-colors"
                    >
                      Remove
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleApplyPromo}
                      disabled={applyingPromo}
                      className="px-6 py-3 bg-[#E11D2E]/10 text-[#E11D2E] border border-[#E11D2E]/30 rounded-[10px] hover:bg-[#E11D2E]/20 font-medium transition-colors"
                    >
                      {applyingPromo ? 'Checking...' : 'Apply'}
                    </button>
                  )}
                </div>
                {discount && (
                  <p className="text-[#22C55E] text-sm mt-2 flex items-center gap-1.5">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Code {discount.code} applied!
                  </p>
                )}
              </div>
            )}

            {/* Attendee Details */}
            <div className="space-y-4">
              <label className="block text-sm font-semibold text-[#B3B3B3]">
                Attendee Details {quantity > 1 && <span className="text-[#737373] font-normal">({quantity} tickets)</span>}
              </label>

              {attendees.map((attendee, index) => (
                <div key={index} className={`ticket-form-section p-5 rounded-xl border transition-colors ${index === 0 ? 'bg-[#141414] border-[#E11D2E]/20' : 'bg-[#0D0D0D] border-[#1F1F1F]'}`}>
                  {quantity > 1 && (
                    <div className="flex items-center gap-3 mb-4">
                      <span className="w-7 h-7 rounded-full bg-[#E11D2E] text-white text-xs flex items-center justify-center font-bold">
                        {index + 1}
                      </span>
                      <span className="text-sm text-[#B3B3B3]">
                        {index === 0 ? 'Primary Ticket Holder' : `Ticket ${index + 1}`}
                      </span>
                    </div>
                  )}

                  <div className="space-y-4">
                    <input
                      type="text"
                      required
                      value={attendee.name}
                      onChange={(e) => updateAttendee(index, 'name', e.target.value)}
                      className="w-full px-4 py-4 bg-[#0D0D0D] border border-[#2A2A2A] rounded-[10px] focus:outline-none focus:ring-2 focus:ring-[#E11D2E]/50 focus:border-[#E11D2E] text-white placeholder-[#737373] transition-all"
                      placeholder={`Full Name ${index === 0 ? '(Required)' : ''}`}
                    />

                    {index === 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <input
                          type="email"
                          value={attendee.email}
                          onChange={(e) => updateAttendee(index, 'email', e.target.value)}
                          className="w-full px-4 py-4 bg-[#0D0D0D] border border-[#2A2A2A] rounded-[10px] focus:outline-none focus:ring-2 focus:ring-[#E11D2E]/50 focus:border-[#E11D2E] text-white placeholder-[#737373] transition-all"
                          placeholder="Email Address"
                        />
                        <input
                          type="tel"
                          value={attendee.phone}
                          onChange={(e) => updateAttendee(index, 'phone', e.target.value)}
                          className="w-full px-4 py-4 bg-[#0D0D0D] border border-[#2A2A2A] rounded-[10px] focus:outline-none focus:ring-2 focus:ring-[#E11D2E]/50 focus:border-[#E11D2E] text-white placeholder-[#737373] transition-all"
                          placeholder="Phone Number"
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Custom Registration Questions */}
            {selectedEventData?.registrationFields && selectedEventData.registrationFields.filter((f: any) => f.label && f.label.trim() !== '').length > 0 && (
              <div className="space-y-4 pt-4 border-t border-[#1F1F1F]">
                <label className="block text-sm font-semibold text-[#B3B3B3]">
                  Additional Information
                </label>
                <div className="ticket-form-section bg-[#141414] border border-[#1F1F1F] rounded-xl p-5 space-y-4">
                  {selectedEventData.registrationFields.map((field: any) => (
                    <div key={field.id}>
                      <label className="block text-sm text-[#B3B3B3] mb-2">
                        {field.label} {field.required && <span className="text-[#E11D2E]">*</span>}
                      </label>
                      {field.type === 'text' && (
                        <input
                          type="text"
                          required={field.required}
                          value={answers[field.id] || ''}
                          onChange={(e) => setAnswers(prev => ({ ...prev, [field.id]: e.target.value }))}
                          className="w-full px-4 py-3 bg-[#0D0D0D] border border-[#2A2A2A] rounded-[10px] focus:outline-none focus:ring-2 focus:ring-[#E11D2E]/50 focus:border-[#E11D2E] text-white"
                        />
                      )}
                      {field.type === 'checkbox' && (
                        <label className="flex items-center gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            required={field.required}
                            checked={answers[field.id] === 'yes'}
                            onChange={(e) => setAnswers(prev => ({ ...prev, [field.id]: e.target.checked ? 'yes' : 'no' }))}
                            className="w-5 h-5 rounded border-[#2A2A2A] bg-[#0D0D0D] text-[#E11D2E] focus:ring-[#E11D2E]/50"
                          />
                          <span className="text-sm text-[#B3B3B3]">Yes, I confirm</span>
                        </label>
                      )}
                      {field.type === 'select' && (
                        <select
                          required={field.required}
                          value={answers[field.id] || ''}
                          onChange={(e) => setAnswers(prev => ({ ...prev, [field.id]: e.target.value }))}
                          className="w-full px-4 py-3 bg-[#0D0D0D] border border-[#2A2A2A] rounded-[10px] focus:outline-none focus:ring-2 focus:ring-[#E11D2E]/50 focus:border-[#E11D2E] text-white appearance-none"
                        >
                          <option value="">Select an option</option>
                          {field.options?.map((opt: string) => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Submit Button - Premium with Shimmer */}
            <button
              type="submit"
              disabled={loading || !selectedEvent}
              className={`ticket-form-submit w-full py-5 px-6 rounded-xl font-semibold text-lg transition-all duration-300 relative overflow-hidden shimmer-hover ${isEarlyBird
                ? 'bg-gradient-to-r from-[#22C55E] to-[#16A34A] hover:shadow-[0_0_32px_rgba(34,197,94,0.3)]'
                : 'bg-gradient-to-r from-[#E11D2E] to-[#B91C1C] hover:shadow-[0_0_32px_rgba(225,29,46,0.4)]'
                } text-white disabled:from-[#333] disabled:to-[#333] disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[#0B0B0B] ${isEarlyBird ? 'focus:ring-[#22C55E]' : 'focus:ring-[#E11D2E]'}`}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-3">
                  <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Processing...
                </span>
              ) : isEarlyBird ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Early Bird - ₹{(calculateTotalPrice() / 100).toLocaleString()}{quantity > 1 ? ` (${quantity} tickets)` : ''}
                </span>
              ) : (
                `Purchase ${quantity > 1 ? `${quantity} Tickets` : 'Ticket'}${selectedEventData ? ` - ₹${(calculateTotalPrice() / 100).toLocaleString()}` : ''}`
              )}
            </button>
          </form>
        </div>

        {/* Card Footer */}
        <div className="bg-[#0D0D0D] px-8 py-5 border-t border-[#1F1F1F]">
          <p className="text-xs text-[#737373] text-center flex items-center justify-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Secure payment powered by Razorpay
          </p>
        </div>
      </div >
    </div >
  );
}
