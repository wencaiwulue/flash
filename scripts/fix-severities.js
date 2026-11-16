#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get original from git
const original = execSync('git show HEAD:docs/status/design-docs-completeness-audit/batch-7.md', { encoding: 'utf8' });

// Parse the 5-column table
const lines = original.split('\n');
let inTable = false;
const severities = {};

for (const line of lines) {
    if (line.startsWith('| ID | 子系统 | 严重度 |')) {
        inTable = true;
        continue;
    }
    if (inTable && line.startsWith('**汇总**')) {
        break;
    }
    if (inTable && line.startsWith('|')) {
        const cells = line.split('|').map(c => c.trim()).filter(c => c !== '');
        if (cells.length === 5 && cells[0] !== 'ID') {
            severities[cells[0]] = cells[2];
        }
    }
}

console.log('Found severities:', severities);
console.log(`Total: ${Object.keys(severities).length}`);
console.log(`P1: ${Object.values(severities).filter(s => s === 'P1').length}`);
console.log(`P2: ${Object.values(severities).filter(s => s === 'P2').length}`);
console.log(`P3: ${Object.values(severities).filter(s => s === 'P3').length}`);

// Now fix the current file
const currentPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../docs/status/design-docs-completeness-audit/batch-7.md');
const current = fs.readFileSync(currentPath, 'utf8');

const newLines = current.split('\n');
let inNewTable = false;
let inHeader = false;

for (let i = 0; i < newLines.length; i++) {
    const line = newLines[i];

    if (line.startsWith('| ID | 主责 | 关联 | 类别 | 严重度 |')) {
        inNewTable = true;
        inHeader = true;
        continue;
    }
    if (inNewTable && line.startsWith('### 汇总统计')) {
        break;
    }
    if (inNewTable && line.startsWith('|')) {
        if (inHeader) {
            inHeader = false;
            continue;
        }
        const cells = line.split('|').map(c => c.trim());
        if (cells[1] && cells[1] in severities) {
            const correctSeverity = severities[cells[1]];
            if (cells[5] !== correctSeverity) {
                console.log(`Fixing ${cells[1]}: ${cells[5]} -> ${correctSeverity}`);
                cells[5] = correctSeverity;
                newLines[i] = cells.join('|');
            }
        }
    }
}

fs.writeFileSync(currentPath, newLines.join('\n'));
console.log('Fixed!');
