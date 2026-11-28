import { Bot, Bell, LayoutGrid, Settings, type LucideIcon } from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon; match: string[] };

/** The four primary items, in the order the design spec gives them. */
export const PRIMARY_NAV: NavItem[] = [
  { href: "/attention", label: "Needs attention", icon: Bell, match: ["/attention"] },
  { href: "/workrooms", label: "Workrooms", icon: LayoutGrid, match: ["/workrooms", "/w/"] },
  { href: "/agents", label: "Agents", icon: Bot, match: ["/agents", "/oversight"] },
  { href: "/settings/profile", label: "Settings", icon: Settings, match: ["/settings"] },
];

export const isActive = (item: NavItem, pathname: string) => item.match.some((prefix) => (prefix.endsWith("/") ? pathname.startsWith(prefix) : pathname === prefix || pathname.startsWith(`${prefix}/`)));

export const WORKROOM_TABS = [
  { segment: "overview", label: "Overview" },
  { segment: "tasks", label: "Tasks" },
  { segment: "team", label: "Team" },
  { segment: "collaboration", label: "Collaboration" },
  { segment: "activity", label: "Activity" },
  { segment: "artifacts", label: "Artifacts" },
  { segment: "ship", label: "Ship" },
  { segment: "settings", label: "Settings" },
] as const;

/** Settings shows only to those the server says may manage this room. */
export const visibleWorkroomTabs = (canManage: boolean) => WORKROOM_TABS.filter((tab) => tab.segment !== "settings" || canManage);
