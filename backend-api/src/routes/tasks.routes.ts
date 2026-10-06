import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createTaskSchema,
  updateTaskSchema,
  changeDeadlineSchema,
  updateProgressSchema,
  setMarksSchema,
  addStudentSchema,
} from '../validators/tasks.validator';
import {
  createTaskHandler,
  listTasksHandler,
  getTaskHandler,
  updateTaskHandler,
  changeDeadlineHandler,
  closeTaskHandler,
  reopenTaskHandler,
  deleteTaskHandler,
  updateProgressHandler,
  toggleInterestedHandler,
  addStudentHandler,
  setMarksHandler,
  myTasksHandler,
} from '../controllers/tasks.controller';

const router = Router();

// Student my-tasks (must be before /:id to avoid matching "my-tasks" as UUID)
router.get(
  '/my-tasks',
  requirePermission('tasks:read:own'),
  myTasksHandler,
);

// Task CRUD
router.post(
  '/',
  requirePermission('tasks:create:batch', 'tasks:create:any'),
  validate(createTaskSchema),
  createTaskHandler,
);

router.get(
  '/',
  requirePermission('tasks:read:own', 'tasks:read:batch', 'tasks:read:any'),
  listTasksHandler,
);

router.get(
  '/:id',
  requirePermission('tasks:read:own', 'tasks:read:batch', 'tasks:read:any'),
  getTaskHandler,
);

router.put(
  '/:id',
  requirePermission('tasks:update:batch', 'tasks:update:any'),
  validate(updateTaskSchema),
  updateTaskHandler,
);

router.delete(
  '/:id',
  requirePermission('tasks:delete:batch', 'tasks:delete:any'),
  deleteTaskHandler,
);

// Deadline change
router.patch(
  '/:id/deadline',
  requirePermission('tasks:update:batch', 'tasks:update:any'),
  validate(changeDeadlineSchema),
  changeDeadlineHandler,
);

// Close / Reopen
router.post(
  '/:id/close',
  requirePermission('tasks:update:batch', 'tasks:update:any'),
  closeTaskHandler,
);

router.post(
  '/:id/reopen',
  requirePermission('tasks:update:batch', 'tasks:update:any'),
  reopenTaskHandler,
);

// Student progress
router.patch(
  '/:id/progress',
  requirePermission('tasks:update:own'),
  validate(updateProgressSchema),
  updateProgressHandler,
);

// Interest toggle (student, optional tasks)
router.post(
  '/:id/interested',
  requirePermission('tasks:update:own'),
  toggleInterestedHandler,
);

// Manual add student (trainer)
router.post(
  '/:id/students',
  requirePermission('tasks:update:batch', 'tasks:update:any'),
  validate(addStudentSchema),
  addStudentHandler,
);

// Marks
router.put(
  '/:id/marks',
  requirePermission('tasks:grade:batch', 'tasks:grade:any'),
  validate(setMarksSchema),
  setMarksHandler,
);

export default router;
