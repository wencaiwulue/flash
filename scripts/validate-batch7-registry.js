#!/usr/bin/env node

/**
 * Validate that batch-7 findings registry has exactly 14 columns and unique IDs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BATCH7_PATH = path.join(__dirname, '../docs/status/design-docs-completeness-audit/batch-7.md');

function parseRegistryFromMarkdown(mdContent) {
  const lines = mdContent.split('\n');
  const findings = [];
  let inRegistry = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Find the start of the 14-column registry
    if (line.startsWith('| ID | 主责 | 关联 | 类别 | 严重度 | 问题陈述 | 源码证据 | 上游证据 | 测试证据 | 影响 | 修订建议 | 置信度 | 验证边界 | 状态 |')) {
      inRegistry = true;
      i++; // Skip header separator
      continue;
    }

    // End of registry (empty line or new section)
    if (inRegistry && (line === '' || line.startsWith('## ') || line.startsWith('### '))) {
      break;
    }

    if (inRegistry && line.startsWith('|')) {
      // Split by | and trim each cell
      const cells = line.split('|').map(c => c.trim()).filter(c => c !== '');
      findings.push({ cells, lineNumber: i + 1, rawLine: line });
    }
  }

  return findings;
}

function validateRegistry() {
  console.log('🔍 Validating batch-7 findings registry...\n');

  const content = fs.readFileSync(BATCH7_PATH, 'utf-8');
  const findings = parseRegistryFromMarkdown(content);

  if (findings.length === 0) {
    console.error('❌ No findings found in registry');
    process.exit(1);
  }

  console.log(`✅ Found ${findings.length} findings in registry\n`);

  const errors = [];
  const ids = new Set();
  let p1Count = 0;
  let p2Count = 0;
  let p3Count = 0;

  for (const finding of findings) {
    const { cells, lineNumber, rawLine } = finding;

    // Check exactly 14 columns
    if (cells.length !== 14) {
      errors.push(`Line ${lineNumber}: Expected 14 columns, found ${cells.length}`);
      console.error(`   Raw: ${rawLine}`);
      continue;
    }

    const [id, , , , severity] = cells;

    // Check ID is unique
    if (ids.has(id)) {
      errors.push(`Line ${lineNumber}: Duplicate ID ${id}`);
    } else {
      ids.add(id);
    }

    // Check ID format is B7-xxx-xx
    if (!id.startsWith('B7-')) {
      errors.push(`Line ${lineNumber}: Invalid ID format ${id}, should start with B7-`);
    }

    // Count severities
    if (severity === 'P1') p1Count++;
    if (severity === 'P2') p2Count++;
    if (severity === 'P3') p3Count++;
  }

  console.log('📊 Severity counts:');
  console.log(`   P1: ${p1Count}`);
  console.log(`   P2: ${p2Count}`);
  console.log(`   P3: ${p3Count}`);
  console.log(`   Total: ${p1Count + p2Count + p3Count}\n`);

  // Verify expected counts (66 findings, 1 P1, 25 P2, 40 P3)
  if (p1Count + p2Count + p3Count !== 66) {
    errors.push(`Expected 66 findings, found ${p1Count + p2Count + p3Count}`);
  }
  if (p1Count !== 1) {
    errors.push(`Expected 1 P1 finding, found ${p1Count}`);
  }
  if (p2Count !== 25) {
    errors.push(`Expected 25 P2 findings, found ${p2Count}`);
  }
  if (p3Count !== 40) {
    errors.push(`Expected 40 P3 findings, found ${p3Count}`);
  }

  if (errors.length === 0) {
    console.log('✅ All registry rows have 14 columns and unique IDs');
    console.log('✅ Counts match expected: 66 total, 1 P1, 25 P2, 40 P3');
    console.log('\n🎉 Registry validation passed!');
    process.exit(0);
  } else {
    console.error('\n❌ Registry validation failed:');
    for (const error of errors) {
      console.error(`   - ${error}`);
    }
    process.exit(1);
  }
}

validateRegistry();
