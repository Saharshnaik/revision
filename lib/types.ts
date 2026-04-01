export type Subject = "Physics" | "Chemistry" | "Maths" | "School / Other";

export type RevisionHistoryAction =
  | "create"
  | "edit"
  | "revise"
  | "skip"
  | "pause"
  | "unpause"
  | "reset"
  | "delete"
  | "restore"
  | "settings_update"
  | "import";

export type AppSettings = {
  user_id: string;
  intervals: number[];
  default_created_date_mode: "today" | "manual";
  show_paused_by_default: boolean;
  show_deleted_by_default: boolean;
  revised_items_stay_visible: boolean;
  updated_at?: string;
};

export type RevisionItem = {
  id: string;
  user_id: string;
  subject: Subject;
  page_number: string | null;
  chapter_name: string | null;
  note: string | null;
  tags: string[];
  priority: number;
  created_date: string;
  last_review_date: string;
  current_stage: number;
  next_due_date: string | null;
  planned_dates: string[];
  paused: boolean;
  carry_priority: number;
  revision_count: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type RevisionHistory = {
  id: string;
  item_id: string | null;
  user_id: string;
  action: RevisionHistoryAction;
  performed_on: string;
  performed_at: string;
  meta: Record<string, unknown>;
  snapshot: Record<string, unknown> | null;
};

export type ExportBundle = {
  exportedAt: string;
  settings: AppSettings | null;
  items: RevisionItem[];
  history: RevisionHistory[];
};
