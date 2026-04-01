'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import {
  CalendarDays,
  Clock3,
  Download,
  Edit3,
  EyeOff,
  FileJson2,
  LogOut,
  MoonStar,
  PauseCircle,
  Plus,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  SkipForward,
  SunMedium,
  Trash2,
  Upload,
  PlayCircle,
  Lock,
} from "lucide-react";

import { createSupabaseClient } from "@/lib/supabase-client";
import type { AppSettings, ExportBundle, RevisionHistory, RevisionItem, Subject } from "@/lib/types";
import {
  addDays,
  buildPlannedDates,
  DEFAULT_INTERVALS,
  effectivePriority,
  normalizeIntervals,
  parseTags,
  sortByDueAndPriority,
  tagsToText,
  todayString,
} from "@/lib/scheduler";
import { parseCsv, toCsv } from "@/lib/csv";

const SUBJECTS: Subject[] = ["Physics", "Chemistry", "Maths", "School / Other"];

const DEFAULT_SETTINGS: AppSettings = {
  user_id: "",
  intervals: DEFAULT_INTERVALS,
  default_created_date_mode: "today",
  show_paused_by_default: false,
  show_deleted_by_default: false,
  revised_items_stay_visible: true,
};

type AuthSession = { user: { id: string; email?: string | null } } | null;

type Draft = {
  subject: Subject;
  page_number: string;
  chapter_name: string;
  note: string;
  tags: string;
  priority: string;
  created_date: string;
};

function classNames(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function formatDate(dateOnly: string) {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(`${dateOnly}T12:00:00`));
}

function groupByDate(items: RevisionItem[]) {
  const map = new Map<string, RevisionItem[]>();
  for (const item of items) {
    const key = item.next_due_date ?? item.created_date;
    const bucket = map.get(key) ?? [];
    bucket.push(item);
    map.set(key, bucket);
  }
  return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
}

async function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function Page() {
  const supabase = useMemo(() => createSupabaseClient(), []);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [session, setSession] = useState<AuthSession>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authEmail, setAuthEmail] = useState("");
  const [authSending, setAuthSending] = useState(false);

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [items, setItems] = useState<RevisionItem[]>([]);
  const [history, setHistory] = useState<RevisionHistory[]>([]);
  const [loadingData, setLoadingData] = useState(false);

  const [query, setQuery] = useState("");
  const [subjectFilter, setSubjectFilter] = useState<"All" | Subject>("All");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused" | "deleted">("active");
  const [viewMode, setViewMode] = useState<"today" | "upcoming" | "all">("today");
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showEditorModal, setShowEditorModal] = useState(false);
  const [editingItem, setEditingItem] = useState<RevisionItem | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [message, setMessage] = useState("");

  const [draft, setDraft] = useState<Draft>({
    subject: "Physics",
    page_number: "",
    chapter_name: "",
    note: "",
    tags: "",
    priority: "0",
    created_date: todayString(),
  });

  const [settingsDraft, setSettingsDraft] = useState({
    intervals: DEFAULT_INTERVALS.join(", "),
    default_created_date_mode: "today" as "today" | "manual",
    show_paused_by_default: false,
    show_deleted_by_default: false,
    revised_items_stay_visible: true,
  });

  const today = todayString();

  useEffect(() => {
    const stored = window.localStorage.getItem("revision-theme");
    const initial = stored === "dark" || stored === "light" ? stored : "light";
    setTheme(initial);
    document.documentElement.classList.toggle("dark", initial === "dark");
  }, []);

  useEffect(() => {
    window.localStorage.setItem("revision-theme", theme);
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      setSession(data.session?.user ? { user: data.session.user } : null);
      setAuthLoading(false);
    };

    void init();

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, currentSession) => {
      setSession(currentSession?.user ? { user: currentSession.user } : null);
      setAuthLoading(false);
    });

    return () => {
      mounted = false;
      authListener.subscription.unsubscribe();
    };
  }, [supabase.auth]);

  useEffect(() => {
    if (!session?.user?.id) return;

    const ensureAccount = async () => {
      const userId = session.user.id;
      const email = session.user.email ?? null;

      await supabase.from("profiles").upsert({ id: userId, email }, { onConflict: "id" });
      const { data: settingsRow } = await supabase.from("app_settings").select("*").eq("user_id", userId).maybeSingle();

      if (!settingsRow) {
        await supabase.from("app_settings").insert({
          user_id: userId,
          intervals: DEFAULT_INTERVALS,
          default_created_date_mode: "today",
          show_paused_by_default: false,
          show_deleted_by_default: false,
          revised_items_stay_visible: true,
        });
      }
    };

    void ensureAccount().catch((error) => setMessage(error.message));
  }, [session, supabase]);

  useEffect(() => {
    if (!session?.user?.id) return;

    const channel = supabase
      .channel(`revision-sync-${session.user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "revision_items", filter: `user_id=eq.${session.user.id}` }, () => {
        void refreshData();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "app_settings", filter: `user_id=eq.${session.user.id}` }, () => {
        void refreshData();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "revision_history", filter: `user_id=eq.${session.user.id}` }, () => {
        void refreshData();
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session?.user?.id]);

  useEffect(() => {
    if (!session?.user?.id) return;
    void refreshData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  useEffect(() => {
    if (!settings) return;
    setSettingsDraft({
      intervals: settings.intervals.join(", "),
      default_created_date_mode: settings.default_created_date_mode,
      show_paused_by_default: settings.show_paused_by_default,
      show_deleted_by_default: settings.show_deleted_by_default,
      revised_items_stay_visible: settings.revised_items_stay_visible,
    });
  }, [settings]);

  async function refreshData(loadHistory = true) {
    if (!session?.user?.id) return;
    setLoadingData(true);
    const userId = session.user.id;

    const [settingsRes, itemsRes] = await Promise.all([
      supabase.from("app_settings").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("revision_items").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    ]);

    if (settingsRes.error) setMessage(settingsRes.error.message);
    if (itemsRes.error) setMessage(itemsRes.error.message);

    setSettings((settingsRes.data as AppSettings | null) ?? null);
    setItems((itemsRes.data as RevisionItem[]) ?? []);

    if (loadHistory) {
      const historyRes = await supabase
        .from("revision_history")
        .select("*")
        .eq("user_id", userId)
        .order("performed_at", { ascending: false })
        .limit(1000);

      if (historyRes.error) setMessage(historyRes.error.message);
      setHistory((historyRes.data as RevisionHistory[]) ?? []);
    }

    setLoadingData(false);
  }

  async function sendMagicLink(event: FormEvent) {
    event.preventDefault();
    setAuthSending(true);
    setMessage("");

    const email = authEmail.trim();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: window.location.origin,
      },
    });

    if (error) setMessage(error.message);
    else setMessage("Magic link sent. Check your email.");
    setAuthSending(false);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setSession(null);
    setItems([]);
    setHistory([]);
  }

  function resetDraft() {
    setDraft({
      subject: "Physics",
      page_number: "",
      chapter_name: "",
      note: "",
      tags: "",
      priority: "0",
      created_date: settings?.default_created_date_mode === "manual" ? "" : todayString(),
    });
    setEditingItem(null);
  }

  function openCreate() {
    resetDraft();
    setShowEditorModal(true);
  }

  function openEdit(item: RevisionItem) {
    setEditingItem(item);
    setDraft({
      subject: item.subject,
      page_number: item.page_number ?? "",
      chapter_name: item.chapter_name ?? "",
      note: item.note ?? "",
      tags: tagsToText(item.tags),
      priority: String(item.priority),
      created_date: item.created_date,
    });
    setShowEditorModal(true);
  }

  async function upsertHistory(
    itemId: string | null,
    action: RevisionHistory["action"],
    meta: Record<string, unknown>,
    snapshot: Record<string, unknown> | null
  ) {
    if (!session?.user?.id) return;
    await supabase.from("revision_history").insert({
      item_id: itemId,
      user_id: session.user.id,
      action,
      performed_on: todayString(),
      meta,
      snapshot,
    });
  }

  async function saveItem(event: FormEvent) {
    event.preventDefault();
    if (!session?.user?.id) return;

    const userId = session.user.id;
    const createdDate = draft.created_date || todayString();
    const priority = Number(draft.priority || 0);
    const tags = parseTags(draft.tags);
    const intervals = settings?.intervals ?? DEFAULT_INTERVALS;

    const base = {
      user_id: userId,
      subject: draft.subject,
      page_number: draft.page_number.trim() || null,
      chapter_name: draft.chapter_name.trim() || null,
      note: draft.note.trim() || null,
      tags,
      priority,
      created_date: createdDate,
    };

    if (editingItem) {
      const shouldRecalc = editingItem.revision_count === 0;
      const nextData = shouldRecalc
        ? {
            last_review_date: createdDate,
            current_stage: 0,
            next_due_date: addDays(createdDate, intervals[0]),
            planned_dates: buildPlannedDates(createdDate, intervals, 0),
          }
        : {};

      const { error } = await supabase
        .from("revision_items")
        .update({
          ...base,
          ...nextData,
          updated_at: new Date().toISOString(),
        })
        .eq("id", editingItem.id)
        .eq("user_id", userId);

      if (error) {
        setMessage(error.message);
        return;
      }

      await upsertHistory(editingItem.id, "edit", { edited: true }, { ...editingItem, ...base, ...nextData });
      setMessage("Item updated.");
    } else {
      const itemId = crypto.randomUUID();
      const payload = {
        id: itemId,
        ...base,
        last_review_date: createdDate,
        current_stage: 0,
        next_due_date: addDays(createdDate, intervals[0]),
        planned_dates: buildPlannedDates(createdDate, intervals, 0),
        paused: false,
        carry_priority: 0,
        revision_count: 0,
      };

      const { error } = await supabase.from("revision_items").insert(payload);
      if (error) {
        setMessage(error.message);
        return;
      }

      await upsertHistory(itemId, "create", { created: true }, payload);
      setMessage("Item added.");
    }

    setShowEditorModal(false);
    setEditingItem(null);
    resetDraft();
    await refreshData();
  }

  async function mutateItem(
    item: RevisionItem,
    action: "revise" | "skip" | "pause" | "unpause" | "reset" | "delete" | "restore"
  ) {
    if (!session?.user?.id) return;
    const userId = session.user.id;
    const intervals = settings?.intervals ?? DEFAULT_INTERVALS;
    const now = todayString();

    let patch: Record<string, unknown> = {};
    let meta: Record<string, unknown> = {};

    if (action === "revise") {
      const nextStage = Math.min(item.current_stage + 1, intervals.length - 1);
      patch = {
        current_stage: nextStage,
        last_review_date: now,
        next_due_date: addDays(now, intervals[nextStage]),
        planned_dates: buildPlannedDates(now, intervals, nextStage),
        carry_priority: 0,
        revision_count: item.revision_count + 1,
        paused: false,
      };
      meta = { from_stage: item.current_stage, to_stage: nextStage };
    }

    if (action === "skip") {
      patch = { next_due_date: addDays(now, 1), carry_priority: item.carry_priority + 1 };
      meta = { skipped_on: now };
    }

    if (action === "pause") {
      patch = { paused: true };
      meta = { paused_on: now };
    }

    if (action === "unpause") {
      patch = { paused: false };
      meta = { resumed_on: now };
    }

    if (action === "reset") {
      patch = {
        current_stage: 0,
        last_review_date: now,
        next_due_date: addDays(now, intervals[0]),
        planned_dates: buildPlannedDates(now, intervals, 0),
        carry_priority: 0,
        revision_count: 0,
        paused: false,
      };
      meta = { reset_on: now };
    }

    if (action === "delete") {
      patch = { deleted_at: new Date().toISOString() };
      meta = { soft_deleted_on: now };
    }

    if (action === "restore") {
      patch = { deleted_at: null };
      meta = { restored_on: now };
    }

    const { error } = await supabase
      .from("revision_items")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", item.id)
      .eq("user_id", userId);

    if (error) {
      setMessage(error.message);
      return;
    }

    await upsertHistory(item.id, action, meta, { ...item, ...patch });
    setMessage(
      action === "revise"
        ? "Marked revised."
        : action === "skip"
        ? "Skipped and carried forward."
        : action === "pause"
        ? "Paused."
        : action === "unpause"
        ? "Resumed."
        : action === "reset"
        ? "Progress reset."
        : action === "delete"
        ? "Moved to deleted items."
        : "Restored."
    );
    await refreshData();
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!session?.user?.id) return;

    const intervals = normalizeIntervals(settingsDraft.intervals);
    const payload = {
      user_id: session.user.id,
      intervals,
      default_created_date_mode: settingsDraft.default_created_date_mode,
      show_paused_by_default: settingsDraft.show_paused_by_default,
      show_deleted_by_default: settingsDraft.show_deleted_by_default,
      revised_items_stay_visible: settingsDraft.revised_items_stay_visible,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from("app_settings").upsert(payload, { onConflict: "user_id" });
    if (error) {
      setMessage(error.message);
      return;
    }

    const updates = items.map((item) => {
      const lastReview = item.last_review_date || item.created_date;
      const nextStage = Math.min(item.current_stage, intervals.length - 1);
      return supabase
        .from("revision_items")
        .update({
          planned_dates: buildPlannedDates(lastReview, intervals, nextStage),
          next_due_date: item.deleted_at ? item.next_due_date : addDays(lastReview, intervals[nextStage]),
        })
        .eq("id", item.id)
        .eq("user_id", session.user.id);
    });

    await Promise.all(updates);
    await upsertHistory(null, "settings_update", { ...settingsDraft, intervals }, null);
    setMessage("Settings saved.");
    setShowSettingsModal(false);
    await refreshData();
  }

  async function exportJson() {
    if (!session?.user?.id) return;
    const bundle: ExportBundle = { exportedAt: new Date().toISOString(), settings, items, history };
    await downloadFile(`revision-system-export-${todayString()}.json`, JSON.stringify(bundle, null, 2), "application/json");
  }

  async function exportCsv() {
    if (!session?.user?.id) return;
    const rows = [
      ...(settings
        ? [{ record_type: "settings", id: "", item_id: "", payload_json: JSON.stringify(settings) }]
        : []),
      ...items.map((item) => ({
        record_type: "item",
        id: item.id,
        item_id: "",
        payload_json: JSON.stringify(item),
      })),
      ...history.map((h) => ({
        record_type: "history",
        id: h.id,
        item_id: h.item_id ?? "",
        payload_json: JSON.stringify(h),
      })),
    ];
    await downloadFile(`revision-system-export-${todayString()}.csv`, toCsv(rows), "text/csv");
  }

  async function importFile(file: File) {
    if (!session?.user?.id) return;
    const text = await file.text();
    const userId = session.user.id;

    try {
      if (file.name.toLowerCase().endsWith(".json")) {
        const parsed = JSON.parse(text) as Partial<ExportBundle>;
        if (parsed.settings) {
          await supabase.from("app_settings").upsert({ ...parsed.settings, user_id: userId }, { onConflict: "user_id" });
        }
        if (Array.isArray(parsed.items) && parsed.items.length) {
          await supabase.from("revision_items").upsert(parsed.items.map((item) => ({ ...item, user_id: userId })), { onConflict: "id" });
        }
        if (Array.isArray(parsed.history) && parsed.history.length) {
          await supabase.from("revision_history").upsert(parsed.history.map((entry) => ({ ...entry, user_id: userId })), { onConflict: "id" });
        }
      } else {
        const rows = parseCsv(text);
        const settingsRow = rows.find((row) => row.record_type === "settings");
        const itemRows = rows.filter((row) => row.record_type === "item");
        const historyRows = rows.filter((row) => row.record_type === "history");

        if (settingsRow?.payload_json) {
          await supabase.from("app_settings").upsert({ ...JSON.parse(settingsRow.payload_json), user_id: userId }, { onConflict: "user_id" });
        }
        if (itemRows.length) {
          await supabase.from("revision_items").upsert(
            itemRows.map((row) => ({ ...JSON.parse(row.payload_json), user_id: userId })),
            { onConflict: "id" }
          );
        }
        if (historyRows.length) {
          await supabase.from("revision_history").upsert(
            historyRows.map((row) => ({ ...JSON.parse(row.payload_json), user_id: userId })),
            { onConflict: "id" }
          );
        }
      }

      setMessage("Import completed.");
      await refreshData();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Import failed.");
    }
  }

  async function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    await importFile(file);
    event.target.value = "";
  }

  const allItems = useMemo(() => items, [items]);

  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return allItems.filter((item) => {
      const subjectOk = subjectFilter === "All" || item.subject === subjectFilter;
      const statusOk =
        statusFilter === "all"
          ? true
          : statusFilter === "active"
          ? !item.paused && !item.deleted_at
          : statusFilter === "paused"
          ? item.paused && !item.deleted_at
          : Boolean(item.deleted_at);

      const text = [item.subject, item.page_number, item.chapter_name, item.note, item.tags.join(" "), String(item.priority), String(item.current_stage)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return subjectOk && statusOk && (!normalizedQuery || text.includes(normalizedQuery));
    });
  }, [allItems, query, subjectFilter, statusFilter]);

  const activeVisible = useMemo(() => visibleItems.filter((item) => !item.deleted_at), [visibleItems]);
  const dueToday = useMemo(
    () => sortByDueAndPriority(activeVisible.filter((item) => !item.paused && (item.next_due_date ?? item.created_date) <= today), today),
    [activeVisible, today]
  );
  const upcomingItems = useMemo(
    () => sortByDueAndPriority(activeVisible.filter((item) => !item.paused && (item.next_due_date ?? item.created_date) > today), today),
    [activeVisible, today]
  );
  const pausedItems = useMemo(() => visibleItems.filter((item) => item.paused && !item.deleted_at), [visibleItems]);
  const deletedItems = useMemo(() => visibleItems.filter((item) => Boolean(item.deleted_at)), [visibleItems]);
  const pausedCount = useMemo(() => items.filter((item) => item.paused && !item.deleted_at).length, [items]);
  const deletedCount = useMemo(() => items.filter((item) => Boolean(item.deleted_at)).length, [items]);

  const loginCard = (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-soft dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-6">
          <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900 text-white dark:bg-white dark:text-slate-900">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-semibold">Revision System</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
            Sign in with email to sync your revision data across devices.
          </p>
        </div>

        <form onSubmit={sendMagicLink} className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium">Email</label>
            <input
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              type="email"
              required
              className="w-full rounded-2xl border border-slate-300 bg-transparent px-4 py-3 outline-none focus:border-slate-900 dark:border-slate-700 dark:focus:border-white"
              placeholder="you@example.com"
            />
          </div>
          <button
            type="submit"
            disabled={authSending}
            className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 font-medium text-white transition hover:opacity-90 disabled:opacity-60 dark:bg-white dark:text-slate-900"
          >
            <Lock className="h-4 w-4" />
            {authSending ? "Sending..." : "Send magic link"}
          </button>
        </form>
        {message ? <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">{message}</p> : null}
      </div>
    </div>
  );

  if (authLoading) {
    return <div className="min-h-screen flex items-center justify-center px-4 text-sm text-slate-600 dark:text-slate-400">Loading...</div>;
  }

  if (!session?.user?.id) return loginCard;

  const summary = [
    { label: "Due today", value: dueToday.length, icon: CalendarDays },
    { label: "Upcoming", value: upcomingItems.length, icon: Clock3 },
    { label: "Paused", value: pausedCount, icon: PauseCircle },
    { label: "Deleted", value: deletedCount, icon: Trash2 },
  ] as const;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-slate-50/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2">
            <div className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-900 text-white dark:bg-white dark:text-slate-900">
              <RotateCcw className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Revision System</h1>
              <p className="text-sm text-slate-600 dark:text-slate-400">Signed in as {session.user.email ?? "user"}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
            >
              {theme === "dark" ? <SunMedium className="h-4 w-4" /> : <MoonStar className="h-4 w-4" />}
              {theme === "dark" ? "Light" : "Dark"}
            </button>
            <button
              onClick={() => setShowSettingsModal(true)}
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
            >
              <Settings className="h-4 w-4" />
              Settings
            </button>
            <button
              onClick={openCreate}
              className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-3 py-2 text-sm font-medium text-white dark:bg-white dark:text-slate-900"
            >
              <Plus className="h-4 w-4" />
              Add item
            </button>
            <button
              onClick={signOut}
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        {message ? <div className="mb-4 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm dark:border-slate-800 dark:bg-slate-900">{message}</div> : null}

        <div className="grid gap-3 md:grid-cols-4">
          {summary.map((card) => {
            const Icon = card.icon;
            return (
              <div key={card.label} className="rounded-3xl border border-slate-200 bg-white p-4 shadow-soft dark:border-slate-800 dark:bg-slate-900">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-600 dark:text-slate-400">{card.label}</span>
                  <Icon className="h-4 w-4 text-slate-500" />
                </div>
                <div className="mt-2 text-3xl font-semibold">{card.value}</div>
              </div>
            );
          })}
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[360px_1fr]">
          <section className="space-y-4">
            <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-soft dark:border-slate-800 dark:bg-slate-900">
              <div className="mb-3 flex items-center gap-2">
                <Search className="h-4 w-4 text-slate-500" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full bg-transparent text-sm outline-none"
                  placeholder="Search notes, tags, page, chapter..."
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={subjectFilter}
                  onChange={(e) => setSubjectFilter(e.target.value as "All" | Subject)}
                  className="rounded-2xl border border-slate-300 bg-transparent px-3 py-2 text-sm dark:border-slate-700"
                >
                  <option value="All">All subjects</option>
                  {SUBJECTS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                  className="rounded-2xl border border-slate-300 bg-transparent px-3 py-2 text-sm dark:border-slate-700"
                >
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="deleted">Deleted</option>
                  <option value="all">All</option>
                </select>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {[
                  ["today", "Today"],
                  ["upcoming", "Upcoming"],
                  ["all", "All"],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setViewMode(key as "today" | "upcoming" | "all")}
                    className={classNames(
                      "rounded-2xl px-3 py-2 text-sm",
                      viewMode === key
                        ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                        : "border border-slate-300 dark:border-slate-700"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-soft dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">Data tools</h2>
                <div className="text-xs text-slate-500">{loadingData ? "Syncing..." : "Synced"}</div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  onClick={exportJson}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
                >
                  <FileJson2 className="h-4 w-4" />
                  JSON
                </button>
                <button
                  onClick={exportCsv}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
                >
                  <Download className="h-4 w-4" />
                  CSV
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
                >
                  <Upload className="h-4 w-4" />
                  Import
                </button>
                <input ref={fileInputRef} type="file" accept=".json,.csv" className="hidden" onChange={handleFileInput} />
              </div>
              <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
                JSON includes settings, items, and history. CSV stores the same payloads in a flattened bundle.
              </p>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-soft dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">Add revision item</h2>
                <button onClick={openCreate} className="text-sm text-slate-500">
                  Open
                </button>
              </div>
              <form onSubmit={saveItem} className="mt-4 space-y-3">
                <select
                  value={draft.subject}
                  onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value as Subject }))}
                  className="w-full rounded-2xl border border-slate-300 bg-transparent px-3 py-3 text-sm dark:border-slate-700"
                  required
                >
                  {SUBJECTS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={draft.page_number}
                    onChange={(e) => setDraft((d) => ({ ...d, page_number: e.target.value }))}
                    className="rounded-2xl border border-slate-300 bg-transparent px-3 py-3 text-sm dark:border-slate-700"
                    placeholder="Page no."
                  />
                  <input
                    value={draft.chapter_name}
                    onChange={(e) => setDraft((d) => ({ ...d, chapter_name: e.target.value }))}
                    className="rounded-2xl border border-slate-300 bg-transparent px-3 py-3 text-sm dark:border-slate-700"
                    placeholder="Chapter"
                  />
                </div>
                <textarea
                  value={draft.note}
                  onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
                  className="min-h-24 w-full rounded-2xl border border-slate-300 bg-transparent px-3 py-3 text-sm outline-none dark:border-slate-700"
                  placeholder="Short note / sentence / formula"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={draft.tags}
                    onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value }))}
                    className="rounded-2xl border border-slate-300 bg-transparent px-3 py-3 text-sm dark:border-slate-700"
                    placeholder="Tags, comma separated"
                  />
                  <input
                    value={draft.priority}
                    onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}
                    type="number"
                    className="rounded-2xl border border-slate-300 bg-transparent px-3 py-3 text-sm dark:border-slate-700"
                    placeholder="Priority"
                  />
                </div>
                <input
                  value={draft.created_date}
                  onChange={(e) => setDraft((d) => ({ ...d, created_date: e.target.value }))}
                  type="date"
                  className="w-full rounded-2xl border border-slate-300 bg-transparent px-3 py-3 text-sm dark:border-slate-700"
                  required={settings?.default_created_date_mode !== "manual"}
                />
                <button
                  type="submit"
                  className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 font-medium text-white dark:bg-white dark:text-slate-900"
                >
                  <Plus className="h-4 w-4" />
                  Save item
                </button>
              </form>
            </div>
          </section>

          <section className="space-y-6">
            {viewMode === "today" ? (
              <Block title="Today's Revision" subtitle="Only active items due now or overdue.">
                {dueToday.length ? dueToday.map((item) => <ItemCard key={item.id} item={item} today={today} onEdit={openEdit} onAction={mutateItem} />) : <EmptyState text="No active items due today." />}
              </Block>
            ) : null}

            {viewMode === "upcoming" ? (
              <Block title="Upcoming revisions" subtitle="Grouped by due date.">
                {upcomingItems.length ? (
                  groupByDate(upcomingItems).map(([date, group]) => (
                    <div key={date} className="space-y-3">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <CalendarDays className="h-4 w-4" />
                        {formatDate(date)} <span className="text-slate-500">({group.length})</span>
                      </div>
                      <div className="space-y-3">
                        {group.map((item) => (
                          <ItemCard key={item.id} item={item} today={today} onEdit={openEdit} onAction={mutateItem} />
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <EmptyState text="No upcoming items." />
                )}
              </Block>
            ) : null}

            {viewMode === "all" ? (
              <Block title="All items" subtitle="Search includes paused and deleted records.">
                {visibleItems.length ? visibleItems.map((item) => <ItemCard key={item.id} item={item} today={today} onEdit={openEdit} onAction={mutateItem} />) : <EmptyState text="No matching items." />}
              </Block>
            ) : null}

            {viewMode !== "all" ? (
              <Block title="All active items" subtitle="Live list outside the selected view.">
                {activeVisible.length ? activeVisible.map((item) => <ItemCard key={item.id} item={item} today={today} onEdit={openEdit} onAction={mutateItem} />) : <EmptyState text="No matching items." />}
              </Block>
            ) : null}

            <Block title="Paused items" subtitle="Stored safely and hidden from daily queue.">
              {pausedItems.length ? pausedItems.map((item) => <ItemCard key={item.id} item={item} today={today} onEdit={openEdit} onAction={mutateItem} />) : <EmptyState text="No paused items." />}
            </Block>
          </section>
        </div>
      </main>

      {showSettingsModal ? (
        <Modal onClose={() => setShowSettingsModal(false)} title="Settings">
          <form onSubmit={saveSettings} className="space-y-4">
            <div>
              <label className="mb-2 block text-sm font-medium">Intervals in days</label>
              <textarea
                value={settingsDraft.intervals}
                onChange={(e) => setSettingsDraft((s) => ({ ...s, intervals: e.target.value }))}
                className="min-h-24 w-full rounded-2xl border border-slate-300 bg-transparent px-3 py-3 text-sm outline-none dark:border-slate-700"
                placeholder="1, 3, 7, 14, 30, 60, 120, 240, 360, 540, 720"
              />
              <p className="mt-1 text-xs text-slate-500">Comma-separated numbers. The schedule is recalculated after save.</p>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">Default creation date</label>
              <select
                value={settingsDraft.default_created_date_mode}
                onChange={(e) => setSettingsDraft((s) => ({ ...s, default_created_date_mode: e.target.value as "today" | "manual" }))}
                className="w-full rounded-2xl border border-slate-300 bg-transparent px-3 py-3 text-sm dark:border-slate-700"
              >
                <option value="today">Today</option>
                <option value="manual">Manual input</option>
              </select>
            </div>

            <label className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 px-4 py-3 dark:border-slate-800">
              <span className="text-sm">Show paused items by default</span>
              <input
                type="checkbox"
                checked={settingsDraft.show_paused_by_default}
                onChange={(e) => setSettingsDraft((s) => ({ ...s, show_paused_by_default: e.target.checked }))}
              />
            </label>

            <label className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 px-4 py-3 dark:border-slate-800">
              <span className="text-sm">Show deleted items by default</span>
              <input
                type="checkbox"
                checked={settingsDraft.show_deleted_by_default}
                onChange={(e) => setSettingsDraft((s) => ({ ...s, show_deleted_by_default: e.target.checked }))}
              />
            </label>

            <label className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 px-4 py-3 dark:border-slate-800">
              <span className="text-sm">Keep revised items visible in All view</span>
              <input
                type="checkbox"
                checked={settingsDraft.revised_items_stay_visible}
                onChange={(e) => setSettingsDraft((s) => ({ ...s, revised_items_stay_visible: e.target.checked }))}
              />
            </label>

            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => setShowSettingsModal(false)} className="flex-1 rounded-2xl border border-slate-300 px-4 py-3 text-sm dark:border-slate-700">
                Cancel
              </button>
              <button type="submit" className="flex-1 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white dark:bg-white dark:text-slate-900">
                Save
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {showEditorModal ? (
        <Modal onClose={() => setShowEditorModal(false)} title={editingItem ? "Edit item" : "Add item"}>
          <form onSubmit={saveItem} className="space-y-3">
            <select
              value={draft.subject}
              onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value as Subject }))}
              className="w-full rounded-2xl border border-slate-300 bg-transparent px-3 py-3 text-sm dark:border-slate-700"
              required
            >
              {SUBJECTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={draft.page_number}
                onChange={(e) => setDraft((d) => ({ ...d, page_number: e.target.value }))}
                className="rounded-2xl border border-slate-300 bg-transparent px-3 py-3 text-sm dark:border-slate-700"
                placeholder="Page no."
              />
              <input
                value={draft.chapter_name}
                onChange={(e) => setDraft((d) => ({ ...d, chapter_name: e.target.value }))}
                className="rounded-2xl border border-slate-300 bg-transparent px-3 py-3 text-sm dark:border-slate-700"
                placeholder="Chapter"
              />
            </div>
            <textarea
              value={draft.note}
              onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
              className="min-h-28 w-full rounded-2xl border border-slate-300 bg-transparent px-3 py-3 text-sm outline-none dark:border-slate-700"
              placeholder="Note / sentence / formula"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={draft.tags}
                onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value }))}
                className="rounded-2xl border border-slate-300 bg-transparent px-3 py-3 text-sm dark:border-slate-700"
                placeholder="Tags, comma separated"
              />
              <input
                value={draft.priority}
                onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}
                type="number"
                className="rounded-2xl border border-slate-300 bg-transparent px-3 py-3 text-sm dark:border-slate-700"
                placeholder="Priority"
              />
            </div>
            <input
              value={draft.created_date}
              onChange={(e) => setDraft((d) => ({ ...d, created_date: e.target.value }))}
              type="date"
              className="w-full rounded-2xl border border-slate-300 bg-transparent px-3 py-3 text-sm dark:border-slate-700"
              required={settings?.default_created_date_mode !== "manual"}
            />
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => setShowEditorModal(false)} className="flex-1 rounded-2xl border border-slate-300 px-4 py-3 text-sm dark:border-slate-700">
                Cancel
              </button>
              <button type="submit" className="flex-1 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white dark:bg-white dark:text-slate-900">
                {editingItem ? "Update" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}

function Block({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-soft dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{subtitle}</p>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-2xl border border-dashed border-slate-300 px-4 py-6 text-sm text-slate-500 dark:border-slate-700">{text}</div>;
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-3 backdrop-blur md:items-center">
      <div className="w-full max-w-2xl rounded-3xl border border-slate-200 bg-white p-4 shadow-soft dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded-2xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ItemCard({
  item,
  today,
  onEdit,
  onAction,
}: {
  item: RevisionItem;
  today: string;
  onEdit: (item: RevisionItem) => void;
  onAction: (item: RevisionItem, action: "revise" | "skip" | "pause" | "unpause" | "reset" | "delete" | "restore") => Promise<void>;
}) {
  const due = item.next_due_date ?? item.created_date;
  const overdue = due <= today ? Math.max(0, Math.round((new Date(`${today}T12:00:00`).getTime() - new Date(`${due}T12:00:00`).getTime()) / 86400000)) : 0;
  const score = effectivePriority(item, today);

  return (
    <div
      className={classNames(
        "rounded-3xl border p-4 transition",
        item.paused ? "border-amber-300 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/30" : "border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-950/40"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-slate-900 px-2.5 py-1 text-xs font-medium text-white dark:bg-white dark:text-slate-900">{item.subject}</span>
            {item.paused ? <span className="rounded-full border border-amber-300 px-2.5 py-1 text-xs text-amber-800 dark:border-amber-900 dark:text-amber-200">Paused</span> : null}
            {item.deleted_at ? <span className="rounded-full border border-rose-300 px-2.5 py-1 text-xs text-rose-700 dark:border-rose-900 dark:text-rose-200">Deleted</span> : null}
            <span className="rounded-full border border-slate-300 px-2.5 py-1 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">Score {score}</span>
          </div>

          <div className="mt-3 space-y-1">
            <div className="text-sm font-medium">
              {item.chapter_name || "Untitled"} {item.page_number ? <span className="text-slate-500">· p. {item.page_number}</span> : null}
            </div>
            {item.note ? <p className="line-clamp-2 text-sm text-slate-600 dark:text-slate-400">{item.note}</p> : null}
            {item.tags.length ? <p className="text-xs text-slate-500 dark:text-slate-500">Tags: {item.tags.join(", ")}</p> : null}
          </div>
        </div>

        <div className="shrink-0 text-right text-xs text-slate-500 dark:text-slate-400">
          <div>Due {formatDate(due)}</div>
          {overdue ? <div className="mt-1 font-medium text-rose-600 dark:text-rose-300">Overdue {overdue}d</div> : null}
          <div className="mt-1">Stage {item.current_stage + 1}</div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={() => onAction(item, "revise")} className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-3 py-2 text-sm font-medium text-white dark:bg-white dark:text-slate-900">
          <RotateCcw className="h-4 w-4" />
          Revised
        </button>
        <button onClick={() => onAction(item, "skip")} className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
          <SkipForward className="h-4 w-4" />
          Skip
        </button>
        <button onClick={() => onAction(item, item.paused ? "unpause" : "pause")} className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
          {item.paused ? <PlayCircle className="h-4 w-4" /> : <PauseCircle className="h-4 w-4" />}
          {item.paused ? "Resume" : "Pause"}
        </button>
        <button onClick={() => onEdit(item)} className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
          <Edit3 className="h-4 w-4" />
          Edit
        </button>
        <button onClick={() => onAction(item, "reset")} className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
          <RotateCcw className="h-4 w-4" />
          Reset
        </button>
        <button
          onClick={() => onAction(item, item.deleted_at ? "restore" : "delete")}
          className="inline-flex items-center gap-2 rounded-2xl border border-rose-300 px-3 py-2 text-sm text-rose-700 dark:border-rose-900 dark:text-rose-200"
        >
          {item.deleted_at ? <EyeOff className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
          {item.deleted_at ? "Restore" : "Delete"}
        </button>
      </div>
    </div>
  );
}
