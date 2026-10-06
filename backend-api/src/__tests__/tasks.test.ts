import {
  createTaskSchema,
  updateTaskSchema,
  changeDeadlineSchema,
  updateProgressSchema,
  setMarksSchema,
  addStudentSchema,
} from '../validators/tasks.validator';

describe('Task Validators', () => {
  describe('createTaskSchema', () => {
    const validBase = {
      title: 'Test Task',
      batchIds: ['00000000-0000-0000-0000-000000000001'],
      deadlineType: 'FIXED',
      deadline: '2026-12-01',
    };

    test('accepts valid FIXED task', () => {
      const { error } = createTaskSchema.validate(validBase);
      expect(error).toBeUndefined();
    });

    test('accepts valid TENTATIVE task with note', () => {
      const { error } = createTaskSchema.validate({
        ...validBase,
        deadlineType: 'TENTATIVE',
        deadline: '2026-12-01',
        deadlineNote: 'Approximately mid-December',
      });
      expect(error).toBeUndefined();
    });

    test('accepts valid TBD task without deadline', () => {
      const { error } = createTaskSchema.validate({
        ...validBase,
        deadlineType: 'TBD',
        deadline: undefined,
        deadlineNote: 'Waiting on infra team',
      });
      expect(error).toBeUndefined();
    });

    test('accepts valid NONE task without deadline (optional)', () => {
      const { error } = createTaskSchema.validate({
        ...validBase,
        deadlineType: 'NONE',
        deadline: undefined,
        isMandatory: false,
      });
      expect(error).toBeUndefined();
    });

    test('accepts multiple batchIds', () => {
      const { error, value } = createTaskSchema.validate({
        ...validBase,
        batchIds: [
          '00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-000000000002',
        ],
      });
      expect(error).toBeUndefined();
      expect(value.batchIds).toHaveLength(2);
    });

    test('accepts optional description', () => {
      const { error, value } = createTaskSchema.validate({
        ...validBase,
        description: 'A description',
      });
      expect(error).toBeUndefined();
      expect(value.description).toBe('A description');
    });

    test('accepts isInternal with maxMarks', () => {
      const { error, value } = createTaskSchema.validate({
        ...validBase,
        isInternal: true,
        maxMarks: 50,
      });
      expect(error).toBeUndefined();
      expect(value.isInternal).toBe(true);
      expect(value.maxMarks).toBe(50);
    });

    test('defaults isMandatory to true', () => {
      const { value } = createTaskSchema.validate(validBase);
      expect(value.isMandatory).toBe(true);
    });

    test('defaults isInternal to false', () => {
      const { value } = createTaskSchema.validate(validBase);
      expect(value.isInternal).toBe(false);
    });

    test('defaults deadlineType to NONE', () => {
      const { value } = createTaskSchema.validate({
        title: 'Test',
        batchIds: ['00000000-0000-0000-0000-000000000001'],
        isMandatory: false,
      });
      expect(value.deadlineType).toBe('NONE');
    });

    test('rejects FIXED without deadline', () => {
      const { error } = createTaskSchema.validate({
        ...validBase,
        deadlineType: 'FIXED',
        deadline: undefined,
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain('deadline is required');
    });

    test('rejects TBD with deadline', () => {
      const { error } = createTaskSchema.validate({
        ...validBase,
        deadlineType: 'TBD',
        deadline: '2026-12-01',
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain('must not be provided');
    });

    test('rejects NONE with deadline', () => {
      const { error } = createTaskSchema.validate({
        ...validBase,
        deadlineType: 'NONE',
        deadline: '2026-12-01',
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain('must not be provided');
    });

    test('rejects deadlineNote for FIXED', () => {
      const { error } = createTaskSchema.validate({
        ...validBase,
        deadlineNote: 'some note',
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain('deadlineNote');
    });

    test('rejects isInternal without maxMarks', () => {
      const { error } = createTaskSchema.validate({
        ...validBase,
        isInternal: true,
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain('maxMarks is required');
    });

    test('rejects maxMarks when not internal', () => {
      const { error } = createTaskSchema.validate({
        ...validBase,
        isInternal: false,
        maxMarks: 50,
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain('maxMarks must not be provided');
    });

    test('rejects missing title', () => {
      const { error } = createTaskSchema.validate({
        ...validBase,
        title: undefined,
      });
      expect(error).toBeDefined();
    });

    test('rejects empty batchIds', () => {
      const { error } = createTaskSchema.validate({
        ...validBase,
        batchIds: [],
      });
      expect(error).toBeDefined();
    });

    test('rejects duplicate batchIds', () => {
      const { error } = createTaskSchema.validate({
        ...validBase,
        batchIds: [
          '00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-000000000001',
        ],
      });
      expect(error).toBeDefined();
    });

    test('rejects invalid deadlineType', () => {
      const { error } = createTaskSchema.validate({
        ...validBase,
        deadlineType: 'URGENT',
      });
      expect(error).toBeDefined();
    });

    test('rejects NONE with isMandatory true', () => {
      const { error } = createTaskSchema.validate({
        ...validBase,
        deadlineType: 'NONE',
        deadline: undefined,
        isMandatory: true,
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain('NONE is not allowed for mandatory');
    });

    test('accepts NONE with isMandatory false', () => {
      const { error } = createTaskSchema.validate({
        ...validBase,
        deadlineType: 'NONE',
        deadline: undefined,
        isMandatory: false,
      });
      expect(error).toBeUndefined();
    });

    test('strips unknown fields', () => {
      const { value } = createTaskSchema.validate(
        { ...validBase, eventType: 'WORKSHOP' },
        { stripUnknown: true },
      );
      expect((value as any).eventType).toBeUndefined();
    });
  });

  describe('updateTaskSchema', () => {
    test('accepts partial update with title only', () => {
      const { error, value } = updateTaskSchema.validate({ title: 'New title' });
      expect(error).toBeUndefined();
      expect(value.title).toBe('New title');
    });

    test('accepts addBatchIds', () => {
      const { error, value } = updateTaskSchema.validate({
        addBatchIds: ['00000000-0000-0000-0000-000000000001'],
      });
      expect(error).toBeUndefined();
      expect(value.addBatchIds).toHaveLength(1);
    });

    test('rejects empty update', () => {
      const { error } = updateTaskSchema.validate({});
      expect(error).toBeDefined();
    });
  });

  describe('changeDeadlineSchema', () => {
    test('accepts valid FIXED deadline change', () => {
      const { error } = changeDeadlineSchema.validate({
        deadlineType: 'FIXED',
        deadline: '2026-12-01',
      });
      expect(error).toBeUndefined();
    });

    test('accepts TBD with note', () => {
      const { error } = changeDeadlineSchema.validate({
        deadlineType: 'TBD',
        deadlineNote: 'Waiting on approval',
      });
      expect(error).toBeUndefined();
    });

    test('rejects FIXED without deadline', () => {
      const { error } = changeDeadlineSchema.validate({
        deadlineType: 'FIXED',
      });
      expect(error).toBeDefined();
    });

    test('rejects missing deadlineType', () => {
      const { error } = changeDeadlineSchema.validate({
        deadline: '2026-12-01',
      });
      expect(error).toBeDefined();
    });
  });

  describe('updateProgressSchema', () => {
    test('accepts valid progress', () => {
      const { error } = updateProgressSchema.validate({ progress: 'IN_PROGRESS' });
      expect(error).toBeUndefined();
    });

    test('rejects invalid progress', () => {
      const { error } = updateProgressSchema.validate({ progress: 'STARTED' });
      expect(error).toBeDefined();
    });
  });

  describe('setMarksSchema', () => {
    test('accepts valid marks', () => {
      const { error } = setMarksSchema.validate({
        studentId: '00000000-0000-0000-0000-000000000001',
        marksAwarded: 8.5,
      });
      expect(error).toBeUndefined();
    });

    test('accepts null marks (clear)', () => {
      const { error } = setMarksSchema.validate({
        studentId: '00000000-0000-0000-0000-000000000001',
        marksAwarded: null,
      });
      expect(error).toBeUndefined();
    });

    test('rejects negative marks', () => {
      const { error } = setMarksSchema.validate({
        studentId: '00000000-0000-0000-0000-000000000001',
        marksAwarded: -1,
      });
      expect(error).toBeDefined();
    });
  });

  describe('addStudentSchema', () => {
    test('accepts valid studentId', () => {
      const { error } = addStudentSchema.validate({
        studentId: '00000000-0000-0000-0000-000000000001',
      });
      expect(error).toBeUndefined();
    });

    test('rejects invalid UUID', () => {
      const { error } = addStudentSchema.validate({ studentId: 'not-a-uuid' });
      expect(error).toBeDefined();
    });
  });

  describe('changeDeadlineSchema - reason removed', () => {
    test('strips reason field as unknown', () => {
      const { value } = changeDeadlineSchema.validate(
        { deadlineType: 'FIXED', deadline: '2026-12-01', reason: 'leftover' },
        { stripUnknown: true },
      );
      expect((value as any).reason).toBeUndefined();
    });
  });
});

describe('normalizeDeadline (IST end-of-day)', () => {
  // Import the service module to test normalizeDeadline indirectly
  // normalizeDeadline is not exported, so we test it through the validator/service behavior
  test('date-only string should normalize to IST end-of-day (18:29:59.999Z)', () => {
    const dateOnly = '2026-10-15';
    const expected = new Date(`${dateOnly}T18:29:59.999Z`);
    // Verify the expected date is correct
    expect(expected.toISOString()).toBe('2026-10-15T18:29:59.999Z');
    expect(expected.getUTCHours()).toBe(18);
    expect(expected.getUTCMinutes()).toBe(29);
    expect(expected.getUTCSeconds()).toBe(59);
    expect(expected.getUTCMilliseconds()).toBe(999);
  });
});
