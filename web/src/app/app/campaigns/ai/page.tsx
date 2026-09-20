// AI Campaign — frontend-only Phase 1 page.
//
// Collects the configuration a future AI backend will consume (target
// business type, location, offer URLs, custom instructions, daily sending
// limit) and simulates a successful save locally. No API call, no campaign
// is created, no cache is touched.

import { useState } from "react";
import { CheckCircle2Icon, Loader2Icon, SparklesIcon } from "lucide-react";
import { Label, NumberInput, TextInput } from "@/components/ui/field";
import { Page, PageBody, PageTopbar, TopbarAction } from "@/components/layout/Page";
import { cn } from "@/lib/utils";

const DAILY_LIMIT_DEFAULT = 50;
const DAILY_LIMIT_MIN = 1;
const DAILY_LIMIT_MAX = 300;

const URL_RE = /^https?:\/\/.+/i;

type Errors = {
    businessType?: string;
    location?: string;
    offers?: string;
    dailyLimit?: string;
};

function FieldError({ message, id }: { message?: string; id: string }) {
    if (!message) return null;
    return (
        <p id={id} role="alert" className="text-[11.5px] text-red-600 mt-1">
            {message}
        </p>
    );
}

const textareaCls =
    "min-h-24 w-full rounded-md border border-slate-200 bg-white px-2.5 py-2 text-[16px] md:text-[12.5px] text-slate-900 placeholder:text-slate-400 outline-none transition-colors focus:border-sky-400 focus:ring-2 focus:ring-sky-100";

export default function AICampaignPage() {
    const [businessType, setBusinessType] = useState("");
    const [location, setLocation] = useState("");
    const [offers, setOffers] = useState<string[]>(["", "", ""]);
    const [instructions, setInstructions] = useState("");
    const [dailyLimit, setDailyLimit] = useState(DAILY_LIMIT_DEFAULT);
    const [errors, setErrors] = useState<Errors>({});
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    function setOffer(index: number, value: string) {
        setOffers((prev) => prev.map((o, i) => (i === index ? value : o)));
        setSaved(false);
    }

    function validate(): Errors {
        const next: Errors = {};
        if (!businessType.trim()) next.businessType = "Enter the type of business to find.";
        if (!location.trim()) next.location = "Enter the location to search in.";
        const filled = offers.map((o) => o.trim()).filter(Boolean);
        if (filled.length === 0) {
            next.offers = "Add at least one offer URL.";
        } else if (!filled.some((o) => URL_RE.test(o))) {
            next.offers = "Enter a valid URL starting with http:// or https://.";
        }
        if (!Number.isInteger(dailyLimit) || dailyLimit < DAILY_LIMIT_MIN || dailyLimit > DAILY_LIMIT_MAX) {
            next.dailyLimit = `Enter a whole number between ${DAILY_LIMIT_MIN} and ${DAILY_LIMIT_MAX}.`;
        }
        return next;
    }

    function onSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (saving) return;
        const next = validate();
        setErrors(next);
        if (Object.keys(next).length > 0) return;
        // Mock only: brief loading state, then a local success state.
        setSaving(true);
        setTimeout(() => {
            setSaving(false);
            setSaved(true);
        }, 600);
    }

    function reset() {
        setBusinessType("");
        setLocation("");
        setOffers(["", "", ""]);
        setInstructions("");
        setDailyLimit(DAILY_LIMIT_DEFAULT);
        setErrors({});
        setSaved(false);
    }

    const usedOffers = offers.map((o) => o.trim()).filter(Boolean);

    return (
        <Page>
            <PageTopbar
                eyebrow="AI Campaign"
                subtitle="Find businesses, personalize outreach, and add them to a Warmbly campaign."
            />
            <PageBody>
                <form onSubmit={onSubmit} noValidate className="max-w-[560px] mx-auto px-5 py-6">
                    <div className="space-y-5">
                        <div>
                            <Label>
                                Business type
                                <TextInput
                                    value={businessType}
                                    onChange={(v) => {
                                        setBusinessType(v);
                                        setSaved(false);
                                    }}
                                    placeholder="e.g. Dental clinics"
                                    invalid={!!errors.businessType}
                                    title={errors.businessType}
                                    describedBy={errors.businessType ? "ai-business-type-error" : undefined}
                                    className="mt-1.5 w-full"
                                />
                            </Label>
                            <FieldError id="ai-business-type-error" message={errors.businessType} />
                        </div>

                        <div>
                            <Label>
                                Location
                                <TextInput
                                    value={location}
                                    onChange={(v) => {
                                        setLocation(v);
                                        setSaved(false);
                                    }}
                                    placeholder="e.g. California, USA"
                                    invalid={!!errors.location}
                                    title={errors.location}
                                    describedBy={errors.location ? "ai-location-error" : undefined}
                                    className="mt-1.5 w-full"
                                />
                            </Label>
                            <FieldError id="ai-location-error" message={errors.location} />
                        </div>

                        <div>
                            <span id="ai-offers-label" className="text-[10px] uppercase tracking-[0.14em] text-slate-400 font-medium block mb-1.5">
                                Offer URLs
                            </span>
                            <div role="group" aria-labelledby="ai-offers-label" className="space-y-1.5">
                                {offers.map((offer, i) => (
                                    <TextInput
                                        key={i}
                                        type="url"
                                        value={offer}
                                        onChange={(v) => setOffer(i, v)}
                                        placeholder={`Offer URL ${i + 1}`}
                                        aria-label={`Offer URL ${i + 1}`}
                                        invalid={!!errors.offers}
                                        describedBy={errors.offers ? "ai-offers-error" : undefined}
                                        className="w-full"
                                    />
                                ))}
                            </div>
                            <FieldError id="ai-offers-error" message={errors.offers} />
                        </div>

                        <div>
                            <Label>
                                Custom instructions
                                <textarea
                                    value={instructions}
                                    onChange={(e) => {
                                        setInstructions(e.target.value);
                                        setSaved(false);
                                    }}
                                    placeholder="Focus on businesses with outdated websites. Keep the outreach concise and avoid generic compliments."
                                    rows={4}
                                    className={cn(textareaCls, "mt-1.5")}
                                />
                            </Label>
                        </div>

                        <div>
                            <Label>
                                Daily sending limit
                                <NumberInput
                                    value={dailyLimit}
                                    onChange={(v) => {
                                        setDailyLimit(v);
                                        setSaved(false);
                                    }}
                                    min={DAILY_LIMIT_MIN}
                                    max={DAILY_LIMIT_MAX}
                                    suffix="emails / day"
                                    describedBy={errors.dailyLimit ? "ai-limit-error" : undefined}
                                    className="mt-1.5 w-44"
                                />
                            </Label>
                            <FieldError id="ai-limit-error" message={errors.dailyLimit} />
                        </div>

                        <div className="pt-1">
                            <button
                                type="submit"
                                disabled={saving}
                                className="h-7 px-2.5 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-[12px] font-medium inline-flex items-center gap-1.5 transition-colors disabled:opacity-60"
                            >
                                {saving ? (
                                    <Loader2Icon className="w-3 h-3 animate-spin" />
                                ) : (
                                    <SparklesIcon className="w-3 h-3" />
                                )}
                                {saving ? "Saving…" : "Start AI Campaign"}
                            </button>
                        </div>

                        {saved && (
                            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
                                <p className="flex items-center gap-1.5 text-[12.5px] text-slate-900 font-medium">
                                    <CheckCircle2Icon className="w-3.5 h-3.5 text-emerald-600" />
                                    AI campaign configuration saved
                                </p>
                                <dl className="mt-2 space-y-1 text-[12px]">
                                    <div className="flex gap-2">
                                        <dt className="w-32 shrink-0 text-slate-400">Business type</dt>
                                        <dd className="text-slate-900 truncate">{businessType.trim()}</dd>
                                    </div>
                                    <div className="flex gap-2">
                                        <dt className="w-32 shrink-0 text-slate-400">Location</dt>
                                        <dd className="text-slate-900 truncate">{location.trim()}</dd>
                                    </div>
                                    {usedOffers.map((o, i) => (
                                        <div key={i} className="flex gap-2">
                                            <dt className="w-32 shrink-0 text-slate-400">
                                                Offer URL {i + 1}
                                            </dt>
                                            <dd className="text-slate-900 truncate font-mono text-[11.5px]">
                                                {o}
                                            </dd>
                                        </div>
                                    ))}
                                    {instructions.trim() && (
                                        <div className="flex gap-2">
                                            <dt className="w-32 shrink-0 text-slate-400">Instructions</dt>
                                            <dd className="text-slate-900 line-clamp-2">
                                                {instructions.trim()}
                                            </dd>
                                        </div>
                                    )}
                                    <div className="flex gap-2">
                                        <dt className="w-32 shrink-0 text-slate-400">Daily limit</dt>
                                        <dd className="text-slate-900 tabular-nums">
                                            {dailyLimit} / day
                                        </dd>
                                    </div>
                                </dl>
                                <div className="mt-2.5">
                                    <TopbarAction variant="ghost" onClick={reset}>
                                        Start over
                                    </TopbarAction>
                                </div>
                            </div>
                        )}
                    </div>
                </form>
            </PageBody>
        </Page>
    );
}
