import { readFile, stat } from 'fs/promises';
import { dirname, join, normalize } from 'path';

/** Versión del formato de captura. Sube cuando cambie qué se guarda (p. ej. pestañas). */
export const CHAPTER_FORMAT = 2;
export const FORMAT_META_RE = /<meta name="ccna-dl-format" content="(\d+)"/i;

export type VerifyResult = {
  ok: boolean;
  /** Problemas que hacen el capítulo inutilizable o incompleto. */
  problems: string[];
  /** Avisos que no impiden darlo por bueno. */
  warnings: string[];
  format: number;
  bytes: number;
  textLength: number;
  localRefs: number;
};

const ERROR_RE =
  /algo salió mal|something went wrong|sesión (ha )?caducad|session (has )?expired|access denied|acceso denegado|iniciar sesión para continuar|<title>[^<]*(404|not found)/i;

function visibleText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Referencias locales (../assets/...) que aparecen en el HTML y en el CSS adoptado. */
export function localAssetRefs(html: string): string[] {
  const out = new Set<string>();
  const re = /\.\.\/(assets\/[A-Za-z0-9_\-./%]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.add(m[1].replace(/[.,;]+$/, ''));
  }
  return [...out];
}

/** Comprobaciones puras sobre el HTML (sin disco). */
export function verifyChapterHtml(html: string): Omit<VerifyResult, 'localRefs'> & { refs: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const bytes = Buffer.byteLength(html, 'utf8');
  const fm = html.match(FORMAT_META_RE);
  const format = fm ? Number(fm[1]) : 1;

  if (bytes === 0) problems.push('archivo vacío (0 bytes)');
  else if (bytes < 2000) problems.push(`archivo diminuto (${bytes} bytes)`);
  if (!/^\s*<!doctype html/i.test(html)) warnings.push('sin <!DOCTYPE html>');
  if (!/<\/html>\s*$/i.test(html.trim())) problems.push('HTML truncado (no termina en </html>)');

  const text = visibleText(html);
  if (text.length < 80) problems.push(`casi sin texto visible (${text.length} caracteres)`);
  if (ERROR_RE.test(text.slice(0, 4000)) && text.length < 1500) {
    problems.push('parece una página de error/login en vez de contenido');
  }
  if (/<meta name="ccna-dl-incomplete"/i.test(html)) {
    problems.push('captura marcada como incompleta (la carga no había terminado al guardar)');
  }
  // spinners/cargando visibles (un único <sgpulse-loader> es parte normal de la página)
  const loading = text.match(/\b(cargando|loading)\b\.{0,3}/i);
  if (loading && text.length < 600) problems.push(`solo muestra "${loading[0]}" (contenido sin cargar)`);

  // pestañas: todas deben tener su panel
  const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  const tabs = (markup.match(/role="tab"/g) || []).length;
  const panels = (markup.match(/role="tabpanel"/g) || []).length;
  if (tabs > panels) warnings.push(`pestañas sin panel guardado: ${tabs} pestañas, ${panels} paneles`);

  return { ok: problems.length === 0, problems, warnings, format, bytes, textLength: text.length, refs: localAssetRefs(html) };
}

/** Verifica un capítulo ya guardado: contenido + que todos los assets referenciados existan y no estén vacíos. */
export async function verifyChapterFile(
  filePath: string,
  siteDir: string,
  opts: { skipAssetCheck?: boolean } = {}
): Promise<VerifyResult> {
  let html: string;
  try {
    html = await readFile(filePath, 'utf8');
  } catch (e) {
    return {
      ok: false,
      problems: ['no se pudo leer el archivo: ' + (e instanceof Error ? e.message : String(e))],
      warnings: [],
      format: 0,
      bytes: 0,
      textLength: 0,
      localRefs: 0,
    };
  }
  const v = verifyChapterHtml(html);
  const problems = [...v.problems];
  const warnings = [...v.warnings];

  if (!opts.skipAssetCheck) {
    const missing: string[] = [];
    const empty: string[] = [];
    for (const rel of v.refs) {
      let dec = rel;
      try {
        dec = decodeURIComponent(rel);
      } catch {
        // se usa tal cual
      }
      const p = normalize(join(siteDir, dec));
      try {
        const st = await stat(p);
        if (st.size === 0) empty.push(rel);
      } catch {
        missing.push(rel);
      }
    }
    if (missing.length) problems.push(`${missing.length} recurso(s) local(es) no existen: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`);
    if (empty.length) problems.push(`${empty.length} recurso(s) local(es) vacíos: ${empty.slice(0, 3).join(', ')}`);
  }

  // referencias remotas a recursos que deberían ser locales
  const remoteRes = html.match(/https?:\/\/[^\s"'()<>\\]+\.(?:woff2?|ttf|otf|png|jpe?g|gif|svg|webp|mp4|pdf)\b/gi);
  if (remoteRes?.length) {
    warnings.push(`${new Set(remoteRes).size} recurso(s) siguen apuntando a internet (no 100% offline)`);
  }

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    format: v.format,
    bytes: v.bytes,
    textLength: v.textLength,
    localRefs: v.refs.length,
  };
}

export function chapterAssetDir(filePath: string): string {
  return join(dirname(dirname(filePath)));
}
