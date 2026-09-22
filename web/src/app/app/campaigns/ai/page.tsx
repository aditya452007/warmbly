// AI Campaign — Phase 2 page.
//
// Collects the configuration a future AI backend will consume (target
// business type, location, offer URLs, custom instructions, daily sending
// limit) and creates a REAL Warmbly campaign in draft via the existing
// campaign API. It never starts the campaign and never enrols contacts.
// Fields the campaign API has no home for (offer URLs, instructions) stay
// frontend-only; name, description and daily limit are persisted.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import { Label, NumberInput, TextInput } from "@/components/ui/field";
import { Page, PageBody, PageTopbar, TopbarAction } from "@/components/layout/Page";
import { cn } from "@/lib/utils";
import useCreateCampaign from "@/lib/api/hooks/app/campaigns/useCreateCampaign";
import type { AppError } from "@/lib/api/client/normalizeError";
import buildError from "@/lib/helper/buildError";

const DAILY_LIMIT_DEFAULT = 50;
const DAILY_LIMIT_MIN = 1;
const DAILY_LIMIT_MAX = 300;

const URL_RE = /^https?:\/\/.+/i;

// Backend caps (internal/utils/validate/campaign.go): name 3-50 chars,
// description 300 chars. The generated name is truncated to fit.
const CAMPAIGN_NAME_MAX = 50;
const CAMPAIGN_DESCRIPTION_MAX = 300;

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
    const navigate = useNavigate();
    const create = useCreateCampaign();
    const [businessType, setBusinessType] = useState("");
    const [location, setLocation] = useState("");
    const [offers, setOffers] = useState<string[]>(["", "", ""]);
    const [instructions, setInstructions] = useState("");
    const [dailyLimit, setDailyLimit] = useState(DAILY_LIMIT_DEFAULT);
    const [errors, setErrors] = useState<Errors>({});

    const submitting = create.isPending;

    function setOffer(index: number, value: string) {
        setOffers((prev) => prev.map((o, i) => (i === index ? value : o)));
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

    // The campaign API only takes name, description and sending fields, so
    // the AI inputs travel as a generated name plus a human-readable
    // description. Offer URLs and instructions have no API home yet and stay
    // frontend-only until the OpenCode bridge owns them.
    function buildPayload() {
        const type = businessType.trim();
        const loc = location.trim();
        const urls = offers.map((o) => o.trim()).filter(Boolean);
        const name = `AI - ${type} - ${loc}`.slice(0, CAMPAIGN_NAME_MAX);
        const parts = [`AI campaign targeting ${type} in ${loc}.`];
        if (urls.length > 0) parts.push(`Offers: ${urls.join(", ")}.`);
        if (instructions.trim()) parts.push(`Instructions: ${instructions.trim()}`);
        const description = parts.join(" ").slice(0, CAMPAIGN_DESCRIPTION_MAX);
        return { name, description, daily_limit: dailyLimit };
    }

    async function onSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (submitting) return;
        const next = validate();
        setErrors(next);
        if (Object.keys(next).length > 0) return;
        // Create only: no steps, no contacts, no start. The campaign lands as
        // a draft and the user continues in the normal campaign UI.
        try {
            const created = await create.mutateAsync(buildPayload());
            toast.success("Campaign created. Add contacts, then launch it.");
            if (created?.id) navigate(`/app/campaigns/${created.id}`);
        } catch (err) {
            toast.error(buildError(err as AppError));
        }
    }

    return (
        <Page>
            <PageTopbar
                eyebrow="AI Campaign"
                subtitle="Find businesses, personalize outreach, and add them to a Warmbly campaign."
            >
                <TopbarAction variant="ghost" href="/app/campaigns/ai/review">
                    Review drafts
                </TopbarAction>
            </PageTopbar>
            <PageBody>
                <form onSubmit={onSubmit} noValidate className="max-w-[560px] mx-auto px-5 py-6">
                    <div className="space-y-5">
                        <div>
                            <Label>
                                Business type
                                <TextInput
                                    value={businessType}
                                    onChange={setBusinessType}
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
                                    onChange={setLocation}
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
                                    onChange={(e) => setInstructions(e.target.value)}
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
                                    onChange={setDailyLimit}
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
                                disabled={submitting}
                                className="h-7 px-2.5 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-[12px] font-medium inline-flex items-center gap-1.5 transition-colors disabled:opacity-60"
                            >
                                {submitting ? (
                                    <Loader2Icon className="w-3 h-3 animate-spin" />
                                ) : (
                                    <SparklesIcon className="w-3 h-3" />
                                )}
                                {submitting ? "Creating…" : "Start AI Campaign"}
                            </button>
                        </div>
                    </div>
                </form>
            </PageBody>
        </Page>
    );
}
