#!/usr/bin/env node
/**
 * Build script: parses applications.md + reports/ → web/dist/data.json
 * Also copies index.html to dist/.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(__dirname, 'dist');

mkdirSync(DIST, { recursive: true });

// ── Parse applications.md ──────────────────────────────────────────
function parseApplications() {
  const paths = [
    join(ROOT, 'data', 'applications.md'),
    join(ROOT, 'applications.md'),
  ];
  let content = '';
  for (const p of paths) {
    if (existsSync(p)) { content = readFileSync(p, 'utf-8'); break; }
  }
  if (!content) return [];

  const lines = content.split('\n');
  const apps = [];
  let num = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('|') || line.startsWith('| #') || line.startsWith('|--') || line.startsWith('| -')) continue;

    let fields;
    if (line.includes('\t')) {
      fields = line.replace(/^\|/, '').trim().split('\t').map(f => f.replace(/\|/g, '').trim());
    } else {
      fields = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(f => f.trim());
    }
    if (fields.length < 8) continue;

    num++;
    const scoreMatch = fields[4].match(/([\d.]+)\/5/);
    const reportMatch = fields[7].match(/\[(\d+)\]\(([^)]+)\)/);

    apps.push({
      number: num,
      date: fields[1],
      company: fields[2],
      role: fields[3],
      score: scoreMatch ? parseFloat(scoreMatch[1]) : 0,
      scoreRaw: fields[4],
      status: fields[5],
      hasPDF: fields[6].includes('\u2705'),
      reportNumber: reportMatch ? reportMatch[1] : '',
      reportPath: reportMatch ? reportMatch[2] : '',
      notes: fields.length > 8 ? fields[8] : '',
    });
  }
  return apps;
}

// ── Normalize status (mirrors Go logic) ────────────────────────────
function normalizeStatus(raw) {
  let s = raw.replace(/\*\*/g, '').trim().toLowerCase();
  // Strip trailing date
  const dateIdx = s.indexOf(' 202');
  if (dateIdx > 0) s = s.slice(0, dateIdx).trim();

  if (/no aplicar|no_aplicar|geo blocker/.test(s) || s === 'skip') return 'skip';
  if (/interview|entrevista/.test(s)) return 'interview';
  if (s === 'offer' || /oferta/.test(s)) return 'offer';
  if (/responded|respondido/.test(s)) return 'responded';
  if (/applied|aplicado|enviada|aplicada/.test(s) || s === 'sent') return 'applied';
  if (/rejected|rechazado|rechazada/.test(s)) return 'rejected';
  if (/discarded|descartado|descartada|cerrada|cancelada/.test(s) || /^duplicado|^dup/.test(s)) return 'discarded';
  if (/evaluated|evaluada|condicional|hold|monitor|evaluar|verificar/.test(s)) return 'evaluated';
  return s;
}

// ── Enrich with report summaries ───────────────────────────────────
function enrichFromReports(apps) {
  const reArchetype = /\*\*Arquetipo(?:\s+detectado)?\*\*\s*\|\s*(.+)/i;
  const reArchetypeColon = /\*\*Arquetipo:\*\*\s*(.+)/i;
  const reTlDr = /\*\*TL;DR\*\*\s*\|\s*(.+)/i;
  const reTlDrColon = /\*\*TL;DR:\*\*\s*(.+)/i;
  const reRemote = /\*\*Remote\*\*\s*\|\s*(.+)/i;
  const reComp = /\*\*Comp\*\*\s*\|\s*(.+)/i;
  const reURL = /^\*\*URL:\*\*\s*(https?:\/\/\S+)/m;

  for (const app of apps) {
    if (!app.reportPath) continue;
    const fullPath = join(ROOT, app.reportPath);
    if (!existsSync(fullPath)) continue;

    const text = readFileSync(fullPath, 'utf-8');
    const header = text.slice(0, 1500);

    const clean = s => s.replace(/\|/g, '').trim();
    const match = (re1, re2) => {
      let m = header.match(re1);
      if (m) return clean(m[1]);
      if (re2) { m = header.match(re2); if (m) return clean(m[1]); }
      return '';
    };

    app.archetype = match(reArchetype, reArchetypeColon);
    let tldr = match(reTlDr, reTlDrColon);
    if (tldr.length > 120) tldr = tldr.slice(0, 117) + '...';
    app.tldr = tldr;
    app.remote = match(reRemote);
    app.comp = match(reComp);

    const urlMatch = header.match(reURL);
    if (urlMatch) app.jobURL = urlMatch[1];

    app.normalizedStatus = normalizeStatus(app.status);
  }
  return apps;
}

// ── Compute metrics ────────────────────────────────────────────────
function computeMetrics(apps) {
  const byStatus = {};
  let totalScore = 0, scored = 0, topScore = 0, withPDF = 0, actionable = 0;

  for (const app of apps) {
    const ns = app.normalizedStatus || normalizeStatus(app.status);
    byStatus[ns] = (byStatus[ns] || 0) + 1;
    if (app.score > 0) { totalScore += app.score; scored++; if (app.score > topScore) topScore = app.score; }
    if (app.hasPDF) withPDF++;
    if (!['skip', 'rejected', 'discarded'].includes(ns)) actionable++;
  }

  return {
    total: apps.length,
    byStatus,
    avgScore: scored > 0 ? Math.round((totalScore / scored) * 10) / 10 : 0,
    topScore,
    withPDF,
    actionable,
  };
}

// ── Main ───────────────────────────────────────────────────────────
const apps = parseApplications();
const enriched = enrichFromReports(apps);
// Ensure normalizedStatus is set for all
for (const app of enriched) {
  if (!app.normalizedStatus) app.normalizedStatus = normalizeStatus(app.status);
}
const metrics = computeMetrics(enriched);

const data = { apps: enriched, metrics, generatedAt: new Date().toISOString() };
writeFileSync(join(DIST, 'data.json'), JSON.stringify(data, null, 2));

// Copy static files
copyFileSync(join(__dirname, 'index.html'), join(DIST, 'index.html'));

console.log(`Built: ${enriched.length} applications → web/dist/data.json`);
