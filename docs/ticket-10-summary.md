# Ticket 10 — Task Assignment Module: Complete Implementation Summary

**Branch:** `ticket-10`  
**Base:** `main` at https://github.com/joannakiruba/Engagement-Intelligence-Platform

---

## 1. What This Module Does

Adds a **Task Assignment** system to the HOPE Engagement Intelligence Platform. Trainers create tasks (homework, practice problems, reading assignments) targeted at one or more batches. Students self-report their progress through four states. Trainers/faculty can optionally award internal marks. The system tracks deadlines, late completions, and feeds stats into the risk engine.

This is **separate from Assessments** — assessments are scored evaluations with sections/questions; tasks are trackable assignments with self-reported progress. This is also **separate from Events** — event registration is a different ticket entirely.

---

## 2. Data Model

### 2.1 New Enums

#### `DeadlineType`
Controls how task deadlines are interpreted:

| Value | Meaning | deadline required? | deadlineNote allowed? |
|-------|---------|--------------------|-----------------------|
| `FIXED` | Hard date; system-enforced. `isOverdue` computed from this. | Yes | No |
| `TENTATIVE` | Advisory date with a note; NOT enforced for overdue/late | Optional | Yes |
| `TBD` | Date not yet decided | No (must be null) | Yes |
| `NONE` | No deadline at all (voluntary task) | No (must be null) | No |

**Why an enum instead of nullable DateTime?** A single nullable `DateTime` can't distinguish "no deadline" from "deadline not yet set" from "soft/advisory deadline." The enum makes each case explicit and enforceable at the validation layer.

**Why TENTATIVE is NOT enforced:** A tentative date is approximate by definition. Marking students as "late" against an approximate date creates false positives. Only FIXED deadlines trigger `isOverdue` (task-level) and `isLate` (per-student). This was a deliberate design decision — see section 10 for the rationale.

#### `TaskProgress`
Self-reported student progress:

| Value | Meaning |
|-------|---------|
| `NOT_STARTED` | Default; also the implicit state for late-joiners (LEFT JOIN, no row) |
| `IN_PROGRESS` | Student has begun work |
| `ALMOST_COMPLETED` | Student is nearly done |
| `COMPLETED` | Triggers `completedAt` timestamp and `isLate` computation |

**Why four states?** Three states (not started / in progress / done) don't give trainers enough granularity. "Almost completed" lets the trainer distinguish "stuck at the start" from "finishing up" without requiring proof upload (separate module).

**Why self-reported, not system-verified?** Tasks cover diverse activities (reading, practice, collaboration). There's no universal way to verify completion. Self-reported progress with the ability to move backwards (including back from COMPLETED) fits the use case.

#### `NotificationType` (modified)
Added `TASK_UPDATE` value to the existing enum.

### 2.2 New Models

#### `Task` (table: `tasks`)

| Column | Type | Default | Nullable | Description |
|--------|------|---------|----------|-------------|
| id | UUID PK | auto | No | |
| createdById | FK → users.id | — | No | Trainer who created the task |
| title | String | — | No | Task name shown to students and trainers |
| description | String | — | Yes | Longer instructions/context |
| isMandatory | Boolean | true | No | Mandatory tasks affect risk; optional don't |
| isInternal | Boolean | false | No | When true, this task has marks (maxMarks required) |
| maxMarks | Float | — | Yes | Required and positive when isInternal=true |
| deadlineType | DeadlineType | NONE | No | See enum table above |
| deadline | DateTime | — | Yes | Required when FIXED; null for TBD/NONE |
| deadlineNote | String | — | Yes | Allowed for TENTATIVE/TBD; human-readable |
| closedAt | DateTime | — | Yes | Non-null = closed (hidden from students, no progress changes) |
| createdAt | DateTime | now() | No | |
| updatedAt | DateTime | @updatedAt | No | |

**Why separate from Assessment?** Fundamentally different semantics — self-reported progress vs. scored evaluations, multi-batch targeting vs. single-batch, flexible deadlines vs. fixed assessment dates. The design doc explicitly decided "separate tables, never Assessment/AssessmentResult."

**Why `closedAt` instead of a boolean?** Stores WHEN the task was closed, which is useful for audit ("was this task closed before or after the student complained?"). A boolean loses that information.

#### `TaskBatch` (table: `task_batches`)

| Column | Type | Description |
|--------|------|-------------|
| taskId | FK → tasks.id | Composite PK part 1 |
| batchId | FK → batches.id | Composite PK part 2 |

Many-to-many join table. A task can target multiple batches (e.g., "Complete chapter 5 exercises" assigned to both Batch Alpha and Batch Beta). Both FKs cascade on delete.

**Why not a single batchId on Task?** Cross-batch tasks are a common pattern — a trainer runs the same homework across two batches. A join table is the standard relational pattern.

#### `TaskSubmission` (table: `task_submissions`)

| Column | Type | Default | Nullable | Description |
|--------|------|---------|----------|-------------|
| id | UUID PK | auto | No | |
| taskId | FK → tasks.id | — | No | |
| studentId | FK → users.id | — | No | |
| progress | TaskProgress | NOT_STARTED | No | Self-reported status |
| isInterested | Boolean | false | No | Student opted in (for optional tasks) |
| completedAt | DateTime | — | Yes | Set when progress → COMPLETED; cleared on undo |
| isLate | Boolean | — | Yes | Was completedAt after task.deadline? Null if not completed or no FIXED deadline |
| marksAwarded | Float | — | Yes | Only for isInternal tasks |
| gradedById | FK → users.id | — | Yes | Who awarded marks; SET NULL on user delete |
| createdAt | DateTime | now() | No | |
| updatedAt | DateTime | @updatedAt | No | |

Unique constraint: `@@unique([taskId, studentId])` — one row per student per task.

**Implicit NOT_STARTED pattern:** Late-joiners and batch-added students do NOT trigger backfill. Queries use `LEFT JOIN TaskSubmission`. Missing row = NOT_STARTED. A row is only created when:
- Task is mandatory → bulk-created at task creation
- Student updates progress on an optional task
- Student toggles interest
- Trainer manually adds a student

This eliminates: backfill logic, timing edge cases (student added at midnight), N×M row creation for optional tasks.

### 2.3 Back-Relations on Existing Models

**User** — 3 new relations:
- `createdTasks` → Task[] (via "TaskCreator")
- `taskSubmissions` → TaskSubmission[] (via "TaskStudent")
- `gradedTaskSubmissions` → TaskSubmission[] (via "TaskGrader")

**Batch** — 1 new relation:
- `taskBatches` → TaskBatch[]

### 2.4 FK Cascade Decisions

| FK | Cascade | Reason |
|----|---------|--------|
| tasks.createdById → users.id | RESTRICT | Don't delete a user who created tasks |
| task_batches → tasks/batches | CASCADE | Association removed with either side |
| task_submissions → tasks | CASCADE | Submissions removed when task deleted |
| task_submissions.studentId → users.id | RESTRICT | Don't delete a student with submissions |
| task_submissions.gradedById → users.id | SET NULL | Keep grade, lose grader reference |

### 2.5 What Was Deliberately Removed

- **TaskDeadlineChange (deadline history table):** Removed by design. Deadline edits simply overwrite. No audit log for deadline changes. Rationale: the overhead of tracking every deadline change doesn't justify the value — trainers rarely need to review a deadline's history, and the general AuditLog table can be used if this need arises later.
- **previousDeadline field:** Not needed — same rationale.
- **Event-related models/code:** Not part of this module. Event, EventRegistration, ProofSubmission are untouched.

---

## 3. Permission System

### 3.1 New Permission Codes

| Code | Description | Roles |
|------|-------------|-------|
| `tasks:create:batch` | Create tasks for own batch | TRAINER |
| `tasks:create:any` | Create tasks for any batch | ADMIN |
| `tasks:read:own` | Read tasks in own batches (student) | STUDENT |
| `tasks:read:batch` | Read tasks for own batch (trainer) | TRAINER |
| `tasks:read:any` | Read any task | FACULTY, MENTOR, COORDINATOR, ADMIN |
| `tasks:update:own` | Update own progress/interest | STUDENT |
| `tasks:update:batch` | Edit tasks for own batch | TRAINER |
| `tasks:update:any` | Edit any task | ADMIN |
| `tasks:delete:batch` | Delete tasks for own batch | TRAINER |
| `tasks:delete:any` | Delete any task | ADMIN |
| `tasks:grade:batch` | Grade internal tasks for own batch | TRAINER |
| `tasks:grade:any` | Grade any internal task | FACULTY, ADMIN |

**Total: 12 new permission codes** (67 → 79).

### 3.2 Role Rationale

- **STUDENT:** Read own tasks, update own progress/interest. No create/edit/delete.
- **TRAINER:** Full CRUD on own batches. Creates tasks, manages deadlines, grades internal tasks.
- **FACULTY:** Read-only + grade any internal task. Faculty oversight of marks without batch restrictions.
- **MENTOR:** Read-only. Tasks are not yet wired into intervention workflow. The task provider feeds risk stats; mentors act on risk scores, not tasks directly. `tasks:read:assigned` can be added later.
- **COORDINATOR:** Read-only. Tracks placement-readiness via risk scores. Doesn't create/edit tasks.
- **ADMIN:** Full access except create is unrestricted (`:any`).

### 3.3 Scope Resolution Algorithm

The controller derives scope from `heldPermissions` (set by `requirePermission` middleware):

```typescript
function deriveScope(req): 'any' | 'batch' | 'own' {
  if (heldPermissions has ':any') return 'any';
  if (heldPermissions has ':batch') return 'batch';
  return 'own';
}
```

- `any` → no filtering, sees everything
- `batch` → service checks `BatchTrainer` table for authorization
- `own` → service checks `BatchMember` table for student's batches

**Why not use the existing `resolveScope` middleware?** The existing middleware operates on a single resource prefix (e.g., `'tasks'`). The task module needs different scope resolution for different operations (read vs. write vs. grade). Deriving scope directly from held permissions in the controller is simpler and more explicit.

---

## 4. API Endpoints

All under `/api/tasks`, require JWT authentication via `authenticateJwt` middleware.

### 4.1 Create Task — `POST /api/tasks`

**Permission:** `tasks:create:batch` | `tasks:create:any`

**Request body:**
```json
{
  "title": "Complete Chapter 5 Exercises",
  "description": "Practice problems from the textbook",
  "batchIds": ["uuid-1", "uuid-2"],
  "isMandatory": true,
  "isInternal": false,
  "deadlineType": "FIXED",
  "deadline": "2026-10-05T23:59:00.000Z"
}
```

**Validation (Joi + custom):**
- `title`: required, non-empty string
- `batchIds`: required array of UUIDs, min 1, unique
- `isMandatory`: optional boolean, defaults `true`
- `isInternal`: optional boolean, defaults `false`
- `maxMarks`: required & positive when `isInternal=true`; rejected otherwise
- `deadlineType`: optional enum, defaults `NONE`
- `deadline`: required ISO datetime when `FIXED`; rejected for TBD/NONE; optional for TENTATIVE
- `deadlineNote`: optional, allowed only for TENTATIVE/TBD

**Service algorithm (`createTask`):**
1. Validate all batchIds exist (404 if any missing)
2. If scope is `batch`: verify trainer is `BatchTrainer` for every batchId (403)
3. Enforce deadline rules and internal marks rules
4. In a `$transaction`:
   a. Create Task with TaskBatch join rows
   b. If mandatory: bulk-create TaskSubmission rows for all students in target batches (deduplicated across batches via `Set`)
5. Return task with batches and submissionCount

**Date normalization:** If `deadline` is a date-only string like `"2026-10-15"` (no time component), it's normalized to `2026-10-15T18:29:59.999Z` (end of day IST = 23:59:59.999 IST in UTC). This avoids the ambiguity of midnight marking every student as "late" on the deadline day itself.

**NONE + mandatory guard:** If `isMandatory` is true and `deadlineType` is `NONE`, the request is rejected with 400. `NONE` means the task is purely voluntary, which contradicts mandatory semantics.

**Response (201):** Full task object with `createdBy`, `taskBatches`, `submissionCount`, `isOverdue`.

### 4.2 List Tasks — `GET /api/tasks`

**Permission:** `tasks:read:own` | `tasks:read:batch` | `tasks:read:any`

**Query parameters:**
| Param | Type | Description |
|-------|------|-------------|
| batchId | UUID | Filter by batch |
| isMandatory | boolean | Filter mandatory/optional |
| isInternal | boolean | Filter internal/external |
| deadlineType | enum | FIXED/TENTATIVE/TBD/NONE |
| status | string | `open` (closedAt null) or `closed` |
| search | string | Case-insensitive title substring |
| page | int | Page number (default 1) |
| limit | int | Items per page (default 20, max 100) |

**Scope filtering algorithm:**
- `any` → all tasks; optional batchId filter
- `batch` → queries trainer's `BatchTrainer` rows, filters to those batch IDs. If `batchId` param provided, validates it's one of trainer's batches (returns empty if not — no 403, to avoid leaking batch existence)
- `own` → queries student's `BatchMember` rows, filters to those batches. Always excludes closed tasks.

**Response (200):** Uses `sendPaginated` with `progressCounts` per task:
```json
{
  "success": true,
  "data": [{
    "id": "...",
    "title": "...",
    "progressCounts": { "NOT_STARTED": 5, "IN_PROGRESS": 4, "ALMOST_COMPLETED": 2, "COMPLETED": 2 },
    "submissionCount": 13,
    "isOverdue": false,
    ...
  }],
  "pagination": { "total": 42, "page": 1, "limit": 20, "pages": 3 }
}
```

### 4.3 Get Task Detail — `GET /api/tasks/:id`

**Permission:** `tasks:read:own` | `tasks:read:batch` | `tasks:read:any`

**Query params:** `progress` — filter submissions by progress status

**Scope check:** Performed after fetch (needs task's batch IDs). Students get `BatchMember` check. Trainers get `BatchTrainer` check. Returns 404 (not 403) to avoid leaking task existence.

**Response:** Full task with all submissions (including student info and grader), `progressCounts` (always from ALL submissions even when filtered), `isOverdue`.

### 4.4 Edit Task — `PUT /api/tasks/:id`

**Permission:** `tasks:update:batch` | `tasks:update:any`

**Request body (all optional, min 1):**
```json
{
  "title": "Updated Title",
  "description": "Updated description",
  "isMandatory": true,
  "isInternal": true,
  "maxMarks": 50,
  "addBatchIds": ["uuid-3"]
}
```

**Data integrity guards:**
- 409 if task is closed (must reopen first)
- `isInternal=false` blocked if any student has `marksAwarded` 
- `maxMarks` lowering blocked if any student's marks exceed new max
- `addBatchIds` only (no remove) — removing batches with existing submissions is deferred

**Transaction logic:**
1. Update task fields
2. If `isInternal` set to false: clear maxMarks
3. Create TaskBatch rows for new batches
4. If mandatory (resolved): bulk-create submissions for new batch students (deduplicated)
5. If `isMandatory` toggled false→true: backfill submissions for ALL students
6. Send `TASK_UPDATE` notifications

### 4.5 Change Deadline — `PATCH /api/tasks/:id/deadline`

**Permission:** `tasks:update:batch` | `tasks:update:any`

**Request body:**
```json
{
  "deadlineType": "FIXED",
  "deadline": "2026-11-01T23:59:00.000Z",
  "deadlineNote": null
}
```

**Why a separate endpoint?** Deadline changes have special recomputation logic that doesn't belong in the general PUT:

**NONE + mandatory guard:** If the task is mandatory (`task.isMandatory === true`), `deadlineType: NONE` is rejected with 400.

**Transaction logic:**
1. Update task's deadlineType, deadline, deadlineNote
2. If new type is FIXED: recompute `isLate` on all COMPLETED submissions by comparing `completedAt` against new deadline
3. If new type is NOT FIXED: clear `isLate` to null on all submissions
4. Send notifications

**isLate recomputation algorithm:**
```typescript
for (each completed submission where completedAt is not null) {
  isLate = completedAt > newDeadline;
}
```

### 4.6 Close Task — `POST /api/tasks/:id/close`

**Permission:** `tasks:update:batch` | `tasks:update:any`

Sets `closedAt` to now. Returns 409 if already closed. Sends TASK_UPDATE notification.

**Effect:** Closed tasks are hidden from students (`getMyTasks` filters them out by default), and no progress/interest changes are allowed. Trainers still see closed tasks in their list.

### 4.7 Reopen Task — `POST /api/tasks/:id/reopen`

**Permission:** `tasks:update:batch` | `tasks:update:any`

Clears `closedAt` to null. Returns 409 if not closed.

**Why POST, not PATCH?** Close/reopen are state transitions, not field updates. POST is more semantically appropriate for actions with side effects (notifications).

### 4.8 Delete Task — `DELETE /api/tasks/:id`

**Permission:** `tasks:delete:batch` | `tasks:delete:any`

**Safety guard:** Returns 409 if any student has progress beyond NOT_STARTED. Must close instead. This prevents accidental data loss — once students have started work, the task should be closed (preserving submissions) rather than deleted.

Cascade deletes handle TaskBatch, TaskSubmission via FK CASCADE.

### 4.9 Student My-Tasks — `GET /api/tasks/my-tasks`

**Permission:** `tasks:read:own`

**Route placement:** Before `/:id` to prevent Express matching "my-tasks" as a UUID param.

**Query params:** `batchId`, `progress`, `isMandatory`, `status` (default: open)

**Response:** Task list with the student's own submission (progress, marks, completedAt, isLate, isInterested). Hides `maxMarks` for non-internal tasks. No deadline history (students don't see it).

### 4.10 Student Progress Update — `PATCH /api/tasks/:id/progress`

**Permission:** `tasks:update:own`

**Body:** `{ "progress": "IN_PROGRESS" }`

**Algorithm:**
1. Verify task exists and not closed (409)
2. Verify student is in one of the task's target batches (403)
3. If no submission exists: create one (works for both mandatory and optional tasks — late joiners have no row by design)
4. Track `isNew` flag to handle the "new submission directly to COMPLETED" edge case
5. If moving TO COMPLETED: set `completedAt = now`, compute `isLate = (deadline type is FIXED && now > deadline)`
6. If moving FROM COMPLETED back: clear `completedAt` and `isLate`

**Bug fix (from prior implementation):** When a new optional-task submission is created directly with COMPLETED, the code creates with default NOT_STARTED first, then applies the completion logic. Without this, `completedAt` and `isLate` would never be set because the check `submission.progress !== 'COMPLETED'` was false immediately after creation.

### 4.11 Toggle Interest — `POST /api/tasks/:id/interested`

**Permission:** `tasks:update:own`

Returns 400 if task is mandatory (interest is only for optional tasks). Returns 409 if closed.

**Algorithm:**
1. Verify batch membership (403 if not a member)
2. If no submission: create one with `isInterested: true`
3. If submission exists: toggle `isInterested`

### 4.12 Manual Add Student — `POST /api/tasks/:id/students`

**Permission:** `tasks:update:batch` | `tasks:update:any`

**Body:** `{ "studentId": "uuid" }`

Validates student is in one of the task's batches (400 if not). Returns 409 if student already has a submission. Creates a submission row with defaults.

**Use case:** Trainer sees an interested student and wants to add them, or adds a specific student to a normally optional task.

### 4.13 Set Marks — `PUT /api/tasks/:id/marks`

**Permission:** `tasks:grade:batch` | `tasks:grade:any`

**Body:** `{ "studentId": "uuid", "marksAwarded": 8.5 }` (or `null` to clear)

Validates: task is internal (400), marks ≤ maxMarks (400), submission exists (404). Sets `gradedById` to the grader; clears it when marks set to null.

---

## 5. Validation Layer

### 5.1 Technology: Joi

Follows the existing project pattern (all other modules use Joi). Schemas use `.custom()` for cross-field validation.

### 5.2 Cross-Field Validation Rules

| Rule | Enforced in | Mechanism |
|------|-------------|-----------|
| FIXED requires deadline | Validator + Service | Joi `.custom()` + service `enforceDeadlineRules()` |
| TBD/NONE rejects deadline | Validator + Service | Same |
| deadlineNote only for TENTATIVE/TBD | Validator + Service | Same |
| isInternal requires maxMarks | Validator + Service | Joi `.custom()` + service check |
| maxMarks rejected when not internal | Validator + Service | Same |
| deadline validated against stored type on partial update | Service only | `changeDeadline()` always requires `deadlineType` |

**Why double-enforce in validator AND service?** The validator catches malformed requests early (400 response before hitting the database). The service re-validates because the validator doesn't know the stored state (e.g., partial updates).

### 5.3 Date-Only Deadline Handling

Dates like `"2026-10-15"` (no time component) are normalized to `"2026-10-15T18:29:59.999Z"` in the service layer's `normalizeDeadline()` function. This means "deadline day" means "end of that day in IST (23:59:59.999 IST = 18:29:59.999 UTC)."

**Why IST?** The platform serves Indian institutions. A student submitting at 11 PM IST on the deadline day should not be marked late. Using UTC end-of-day (`T23:59:59.999Z`) would cut off at 5:30 AM IST the next day — too generous and semantically wrong for the users.

### 5.4 NONE + Mandatory Cross-Field Validation

`deadlineType: NONE` combined with `isMandatory: true` is rejected at both the validator and service layers (400). Rationale: `NONE` signals a purely voluntary task — no deadline, no enforcement. A mandatory task must have at least a TBD or TENTATIVE deadline to signal intent.

---

## 6. Service Layer Architecture

### 6.1 Pattern

All service functions follow the existing project pattern:
- Accept typed inputs, return data objects
- Throw `ServiceError(message, statusCode)` for business rule violations
- Controller catches with `handleServiceError()` → `sendError()`

### 6.2 Transaction Boundaries

| Operation | Transactional? | Why |
|-----------|---------------|-----|
| createTask | Yes | Task + TaskBatch + TaskSubmission must be atomic |
| updateTask | Yes | Task update + batch adds + submission backfill |
| changeDeadline | Yes | Deadline update + isLate recomputation must be atomic |
| deleteTask | No | Single delete (cascades handle the rest via FK) |
| closeTask / reopenTask | No | Single field update |
| updateStudentProgress | No | Single row update (submission already exists) |

### 6.3 Notification Helper

```typescript
async function notifyStudents(taskId, title, message) {
  // Fetch all studentIds with submissions, bulk-create notifications
  prisma.notification.createMany(...)
}
```

Uses `TASK_UPDATE` notification type. Called on: edit, deadline change, close, reopen. NOT called on: create (students discover tasks via their task list), delete (task is gone anyway), progress update (that's the student's own action).

### 6.4 Risk Engine Provider

File: `src/providers/task.provider.ts`

Exports `getTaskStats(studentId, batchId)` → `{ missedCount, lateCount, totalMandatory }`

**Algorithm:**
1. Find all mandatory, non-closed tasks targeting the given batch
2. For each with a FIXED deadline in the past:
   - No submission or not COMPLETED → `missedCount++`
   - Completed but `isLate` → `lateCount++`
3. Return counts

**Integration seam:** The risk-engine team calls `getTaskStats()` from their `feature-builder.ts`. They decide the weight. This module does NOT modify the risk pipeline.

---

## 7. isOverdue vs isLate

| Field | Level | Computed | Meaning |
|-------|-------|----------|---------|
| `isOverdue` | Task | On every read | `deadlineType === 'FIXED' && now > deadline` |
| `isLate` | TaskSubmission (per-student) | On completion or deadline change | `completedAt > task.deadline` (FIXED only) |

- `isOverdue` tells you the task's deadline has passed.
- `isLate` tells you a specific student finished after the deadline.
- TENTATIVE deadlines trigger NEITHER — they are advisory only.
- Both are `null`/`false` when there's no FIXED deadline.

---

## 8. Seed Data

6 tasks seeded across batches:

| Title | DeadlineType | Mandatory | Internal | MaxMarks | Multi-batch |
|-------|-------------|-----------|----------|----------|-------------|
| Complete TypeScript exercises | FIXED (day+7) | Yes | No | — | Yes (2) |
| Submit project proposal | TENTATIVE (day+14) | Yes | Yes | 50 | No |
| Set up CI/CD pipeline | TBD | Yes | No | — | No |
| Contribute to open-source project | NONE | No | No | — | Yes (2) |
| Database normalization worksheet | FIXED (day+5) | Yes | Yes | 25 | No |
| Peer code review | TENTATIVE (day+10) | No | No | — | No |

Mandatory tasks get submission rows bulk-created for all students in target batches.

---

## 9. Migration

File: `src/prisma/migrations/20261005_add_task_module/migration.sql`

1. Creates `DeadlineType` and `TaskProgress` enums
2. Adds `TASK_UPDATE` to `NotificationType` (`ALTER TYPE ... ADD VALUE` — non-transactional in PostgreSQL, standard for enum extension)
3. Creates `tasks` table
4. Creates `task_batches` join table with composite PK
5. Creates `task_submissions` table with unique index on (taskId, studentId)
6. Adds all foreign key constraints with appropriate cascade behavior

**Note on `ALTER TYPE ... ADD VALUE`:** PostgreSQL requires this to be outside a transaction block. Prisma handles this automatically in its migration runner, but if running manually, ensure this statement is not wrapped in a `BEGIN/COMMIT`.

---

## 10. Bugs Found and Fixed

### Bug 1 (HIGH): `updateStudentProgress` — no batch membership check

**Problem:** Any student could call `PATCH /api/tasks/:id/progress` on any task, even tasks for batches they're not in. For optional tasks, a submission row would be created for a student who shouldn't have access.

**Root cause:** The original implementation only checked task existence and closed state, not whether the student belonged to the task's target batches.

**Fix:** Added `BatchMember` check before allowing progress updates. Returns 403 if the student is not in any of the task's target batches.

### Bug 2 (HIGH): `toggleInterested` — no batch membership check

**Problem:** Same as Bug 1. Any student could toggle interest on any optional task.

**Fix:** Same pattern — `BatchMember` check before the submission lookup/create.

### Bug 3 (MEDIUM): `updateStudentProgress` — completedAt not set for new submissions

**Problem:** When an optional-task student made their first progress update directly to COMPLETED, the code created the submission with `progress: 'COMPLETED'` then checked `submission.progress !== 'COMPLETED'` which was false (just set it). So `completedAt` and `isLate` were never computed.

**Fix:** Track `isNew` flag. Create new submissions with default NOT_STARTED, then let the existing completion logic handle the COMPLETED transition.

### Bug 4 (MEDIUM): `getTaskById` — student scope falls through to trainer check

**Problem:** The `GET /api/tasks/:id` route allows `tasks:read:own` (students), but scope derivation only distinguished `any` vs `batch`. Students hit the `BatchTrainer` check and got 403.

**Fix:** Three-way scope derivation (`any` / `batch` / `own`) with corresponding `BatchMember` check for `own` scope.

### Bug 5 (from prior implementation): `listTasks` auth bypass via batchId filter

**Problem:** When a batch-scoped trainer provided a `batchId` query parameter, the scope restriction was skipped. A trainer could see tasks for batches they don't train.

**Fix:** Always validate `batchId` against the trainer's assigned batches. Return empty results (not 403) to avoid leaking batch existence.

### Bug 6: Schema never committed to Prisma file

**Problem:** The prior implementation wrote migration SQL and service code referencing Task models, but never added the models to `schema.prisma`. Prisma generate would not create the Task client, so runtime would fail on any `prisma.task.*` call.

**Fix:** This implementation adds all models correctly to `schema.prisma` and validates with `prisma generate` and `tsc --noEmit`.

---

## 11. Alternatives Considered and Rejected

### 11.1 Reuse Assessment table for tasks
**Rejected:** Assessments have sections, questions, weighted scoring, and single-batch targeting. Tasks have self-reported progress, multi-batch targeting, and flexible deadlines. Forcing one into the other would require extensive null-checking and conditional logic. Separate tables are cleaner.

### 11.2 Deadline history (TaskDeadlineChange table)
**Original design had it; removed.** Every deadline change would be logged with old/new values and a reason field. Removed because:
- Trainers rarely need historical deadline data
- The general AuditLog table can serve this purpose if needed
- It adds complexity to the deadline change endpoint without clear user value

### 11.3 Single batchId instead of TaskBatch join table
**Rejected for final design.** Simpler, but cross-batch tasks are a real use case. A trainer running the same homework in two batches would have to create duplicate tasks and manage them independently.

### 11.4 System-verified completion instead of self-reported
**Rejected:** Tasks cover too many activity types (reading, practice, collaboration). There's no universal completion signal. Self-reported progress with trainer oversight (marks, interest lists) fits better.

### 11.5 UTC end-of-day for deadline normalization
**Rejected (IST adopted instead):** Initially `normalizeDeadline()` used `T23:59:59.999Z` (UTC end-of-day). Changed to `T18:29:59.999Z` (IST end-of-day) because the platform serves Indian institutions. UTC end-of-day would mean 5:30 AM IST the next day, which is semantically wrong for date-only deadlines.

### 11.6 `isOverdue` stored in the database
**Rejected:** It's a function of `now()` — storing it would make it stale immediately. Computing on read is correct.

### 11.7 TENTATIVE triggering late/overdue
**Rejected:** TENTATIVE means "approximately this date." Enforcing lateness against an approximate date creates false positives and undermines the semantic distinction between FIXED and TENTATIVE.

---

## 12. Review Discussion Points

### 12.1 Security

- **Batch membership authorization:** Every student-facing endpoint verifies batch membership. This was a HIGH bug in the prior implementation.
- **Scope derivation:** Derived from held permissions, not from request body. `createdById` always comes from JWT, never from the client.
- **Information leakage:** Unauthorized access returns 404 (not 403) to avoid leaking task/batch existence.

### 12.2 Data Integrity

- **Closed task guard:** All mutation endpoints check `closedAt`. Closed tasks are read-only for students and require explicit reopen for trainers.
- **Delete guard:** Cannot delete a task with student progress beyond NOT_STARTED.
- **isInternal toggle guard:** Cannot disable internal marks if students already have marks.
- **maxMarks lowering guard:** Cannot lower below existing awarded marks.

### 12.3 Performance Considerations

- **Bulk submission creation:** Uses `createMany` (single query) instead of individual creates.
- **List endpoint:** Uses pagination with `skip/take`. Progress counts computed from included submissions — consider adding a materialized view or cache if task lists become slow at scale.
- **N+1 potential:** `getTaskById` includes all submissions in one query. For tasks with thousands of students, the response payload could be large. Consider pagination on the submissions sub-resource.

### 12.4 Things NOT Covered (Deferred)

- **Remove batch from task:** Only `addBatchIds` is supported. Removing a batch with existing submissions needs a decision about orphaned submission rows.
- **Bulk marks upload:** The `POST /:id/marks/bulk` endpoint from the prior design is deferred.
- **Marks export:** `GET /:id/marks/export` endpoint is deferred.
- **Wiring into risk engine pipeline:** `getTaskStats()` provider is ready. Integration into `feature-builder.ts` / `rule-engine.ts` is the risk-engine teammate's responsibility.
- **Email notifications:** `notifyStudents()` creates in-app notifications only. Email dispatch (via BullMQ) is pending a decision on frequency and template.

### 12.5 Edge Cases to Test in Integration

- Create task targeting batches the trainer doesn't own (should 403)
- Student progress update on a closed task (should 409)
- Student toggling interest on a mandatory task (should 400)
- Changing deadline type from FIXED to TBD (should clear all isLate values)
- Lowering maxMarks when a student has marks above the new max (should 409)
- Deleting a task after students have started work (should 409)
- Student viewing a task from another batch (should 404)
- Creating an internal task without maxMarks (should 400)
- Date-only deadline normalization ("2026-10-15" → end of day IST = 18:29:59.999Z)
- Creating a mandatory task with deadlineType NONE (should 400)

---

## 13. Files Changed

### New Files (7)

| File | Purpose |
|------|---------|
| `src/validators/tasks.validator.ts` | 6 Joi schemas with cross-field validation |
| `src/services/tasks.service.ts` | All task business logic (15 exported functions) |
| `src/controllers/tasks.controller.ts` | 13 Express handlers with scope derivation |
| `src/routes/tasks.routes.ts` | 13 route definitions with permission middleware |
| `src/providers/task.provider.ts` | Risk engine integration seam |
| `src/prisma/migrations/20261005_add_task_module/migration.sql` | DDL for all new tables/enums |
| `src/__tests__/tasks.test.ts` | 35 validator unit tests |

### Modified Files (5)

| File | Change |
|------|--------|
| `src/prisma/schema.prisma` | Added 2 enums, 3 models, 3 User relations, 1 Batch relation, TASK_UPDATE notification |
| `src/prisma/permission-catalog.ts` | 12 new permission codes across 6 roles |
| `src/prisma/seed.ts` | 6 sample tasks with bulk submissions |
| `src/server.ts` | Registered `/api/tasks` route |
| `tests/auth-rbac.test.ts` | Updated permission count 67 → 79 |

### Not Touched

- Event/EventRegistration/ProofSubmission models and routes (separate ticket)
- AuditLog model (general-purpose, not deadline-specific)
- Any file outside the backend-api directory

---

## 14. How to Run

```bash
cd backend-api

# Generate Prisma client
npx prisma generate

# Run migration (when database is available)
npx prisma migrate dev --name ticket10_task_assignment

# Seed (includes task data)
SEED_TEST_PASSWORD="HopeTest2026!@dev" npm run seed

# Type check
npx tsc --noEmit

# Tests
npx jest
```

---

## 15. What's Next

1. Risk-engine team: wire `getTaskStats()` into `feature-builder.ts`
2. Frontend: task list and detail views, progress update UI
3. Decide on email notification templates and frequency
4. Consider bulk marks upload if trainers need CSV import
5. Consider batch removal from tasks (needs orphaned submission decision)
