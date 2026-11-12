# <Feature Name> Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** <one-sentence outcome>

**Architecture:** <2-3 sentences about the chosen structure>

**Tech Stack:** <runtime, language, libraries and test tools>

## Global Constraints

<exact requirements copied from the approved design spec>

## 实施理由与步骤依据

<为什么按此依赖顺序、为什么修改这些文件/接口、为什么选择这些测试和回滚方式；不能只有步骤标题>

## File Structure

<exact create/modify/test files and each file's responsibility>

---

### Task 1: <Component Name>

**Files:**
- Create: <path>
- Modify: <path:line>
- Test: <path>

**Interfaces:**
- Consumes: <exact inputs/signatures>
- Produces: <exact outputs/signatures>

- [ ] **Step 1: Write the failing test**

<actual test code and why this case distinguishes correct from incorrect behavior>

- [ ] **Step 2: Run test to verify it fails**

<exact command and expected failure>

- [ ] **Step 3: Implement the minimal change**

<actual implementation code and why this is the smallest correct change>

- [ ] **Step 4: Run test to verify it passes**

<exact command and expected result>

- [ ] **Step 5: Commit**

<exact files and commit command>
