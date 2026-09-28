import { Bot, FolderTree, History, Settings as SettingsIcon, SquareTerminal, Target, type LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { AppId } from '../shell/windows';
import { AgentsApp } from './agents/AgentsApp';
import { FilesApp } from './files/FilesApp';
import { MissionApp } from './mission/MissionApp';
import { TerminalApp } from './terminal/TerminalApp';
import { TimelineApp } from './timeline/TimelineApp';
import { SettingsApp } from './settings/SettingsApp';

export interface AppDef {
  id: AppId;
  title: string;
  icon: LucideIcon;
  size: { w: number; h: number };
  component: ComponentType;
}

export const APPS: AppDef[] = [
  { id: 'mission', title: 'Mission Control', icon: Target, size: { w: 1040, h: 680 }, component: MissionApp },
  { id: 'agents', title: 'Agents', icon: Bot, size: { w: 980, h: 660 }, component: AgentsApp },
  { id: 'files', title: 'Files', icon: FolderTree, size: { w: 940, h: 620 }, component: FilesApp },
  { id: 'terminal', title: 'Terminal', icon: SquareTerminal, size: { w: 820, h: 480 }, component: TerminalApp },
  { id: 'timeline', title: 'Timeline', icon: History, size: { w: 720, h: 520 }, component: TimelineApp },
  { id: 'settings', title: 'Settings', icon: SettingsIcon, size: { w: 880, h: 620 }, component: SettingsApp },
];

export const appById = (id: AppId) => APPS.find((a) => a.id === id)!;
