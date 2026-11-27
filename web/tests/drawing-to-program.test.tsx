import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeatureSchema, FeatureTable, GenPlan, GenPreview, Machine } from '../src/api/types';
import { makeUser, renderApp } from './helpers';

// The 3D simulator needs WebGL (none in jsdom): a stub that reports its safety checks.
const sim = vi.hoisted(() => ({ errors: 0, stock: null as unknown }));
vi.mock('../src/cnc-sim/CncSimulatorView', async () => {
  const { useEffect } = await import('react');
  return {
    default: function SimStub(props: {
      programText?: string;
      stock?: unknown;
      onChecks?: (c: unknown[], e: number) => void;
    }) {
      const { programText, onChecks } = props;
      sim.stock = props.stock;
      useEffect(() => {
        const checks = Array.from({ length: sim.errors }, (_, k) => ({
          severity: 'error',
          code: 'rapid-into-material',
          message: 'Rapid move of T04 runs through material.',
          line: 12 + k,
          move: k,
          time: k,
        }));
        onChecks?.(checks, sim.errors);
      }, [programText, onChecks]);
      return <div data-testid="sim-stub" />;
    },
  };
});

vi.mock('../src/components/PartPreview3D', () => ({ default: () => <div data-testid="part-3d" /> }));

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sim.errors = 0;
});

const done = (v: number | string) => ({ ai: null, value: v, confirmed: true });

const SCHEMA: FeatureSchema = {
  header: [
    { key: 'material_grade', label: 'Material grade', kind: 'text' },
    { key: 'bar_diameter', label: 'Bar diameter', kind: 'mm' },
    { key: 'overall_length', label: 'Overall length', kind: 'mm' },
  ],
  feature_types: [
    {
      type: 'od',
      label: 'OD (outside diameter)',
      fields: [
        { key: 'diameter', label: 'Diameter', kind: 'mm' },
        { key: 'length', label: 'Length', kind: 'mm' },
      ],
    },
  ],
};

const TABLE: FeatureTable = {
  id: 4,
  part_number: 'P-100',
  drawing_ref: 'p100.pdf',
  source: 'manual',
  status: 'confirmed',
  data: {
    header: { material_grade: done('EN8'), bar_diameter: done(40), overall_length: done(30) },
    features: [{ type: 'od', fields: { diameter: done(30), length: done(30) } }],
  },
  unconfirmed: [],
  confirmed_by_name: 'Eng',
  confirmed_at: '2026-11-13T00:00:00Z',
  updated_at: '2026-11-13T00:00:00Z',
  programs: [],
};

const MACHINE = {
  id: 2,
  key: 'lmw-lathe-1',
  name: 'LMW Lathe 1',
  controller: 'FANUC 0i-TF',
  ip_address: '192.168.1.20',
  focas_port: 8193,
  status: 'in_service',
  tools: [],
  limits: { spindle_rpm_max: 3000 },
  limits_missing: [],
} as unknown as Machine;

const PLAN: GenPlan = {
  feature_table_id: 4,
  part_number: 'P-100',
  table_status: 'confirmed',
  machine_id: 2,
  machine_name: 'LMW Lathe 1',
  geometry_problems: [],
  program_number: 1000,
  proven_programs: ['O0001', 'O0004'],
  controller_problem: null,
  operations: [
    {
      key: 'rough',
      label: 'Face and rough turn (G71)',
      tool_types: ['od_rough'],
      needed: true,
      tools: [{ tool_code: 'T0202', description: 'WNMG 0.8 RG', tool_type: 'od_rough' }],
      tool_suggestion: { value: 'T0202', source: 'machine tool list', note: 'T0202 WNMG 0.8 RG' },
      params: [
        {
          key: 'depth_of_cut',
          label: 'Depth of cut per side',
          unit: 'mm',
          kind: 'num',
          choices: [],
          hint: '',
          suggestion: { value: 1, source: 'proven program', note: 'O0004 line 30 (TNMG 0.8); used 2x' },
        },
        {
          key: 'face_stock',
          label: 'Stock on the front face',
          unit: 'mm',
          kind: 'num',
          choices: [],
          hint: '',
          suggestion: null,
        },
      ],
    },
  ],
};

const NOT_YET: GenPreview = {
  ok: false,
  problems: ['Face and rough turn (G71): Stock on the front face not entered.'],
  operations: [],
  text: null,
  validation: null,
  toolpath: null,
  table_problem: null,
  controller_problem: null,
  notes: [],
};

const READY: GenPreview = {
  ok: true,
  problems: [],
  operations: [
    { key: 'rough', label: 'Face and rough turn (G71)', tool_code: 'T0202', rpm: 1800, summary: 'Face' },
  ],
  text: '%\nO1000(P-100)\nM30\n%\n',
  validation: { ok: true, errors: [], warnings: [], infos: [] },
  toolpath: null,
  table_problem: null,
  controller_problem: null,
  notes: [],
};

const DRAWINGS = [
  {
    id: 5,
    part_number: 'P-100',
    filename: 'p100.pdf',
    content_type: 'application/pdf',
    size: 10,
    sha256: 'abcdefabcdefabcdef',
    uploaded_by_name: 'Eng',
    uploaded_at: '2026-11-13T00:00:00Z',
  },
];

function routes(preview: (body: unknown) => GenPreview) {
  return {
    'GET /feature-tables': [],
    'GET /feature-tables/schema': SCHEMA,
    'GET /feature-tables/4': TABLE,
    'GET /machines': [MACHINE],
    'GET /machines/2/live': { machine_id: 2, state: 'offline', status: null },
    'GET /drawings': [],
    'GET /capability': { part_number: 'P-100', available: [], excluded: [] },
    'GET /generator/plan': PLAN,
    'POST /generator/preview': preview,
  };
}

describe('drawing to program', () => {
  it('pre-fills the setup with its source and generates only when the button is pressed', async () => {
    const { calls } = renderApp('/make?table=4&machine=2', makeUser(['engineer']), {
      ...routes(() => NOT_YET),
      'GET /drawings': DRAWINGS,
    });
    const doc = await screen.findByLabelText('Face and rough turn (G71) Depth of cut per side');
    expect(doc).toHaveValue('1');
    expect(screen.getByText('Company reference: O0004 line 30 (TNMG 0.8); used 2x')).toBeInTheDocument();
    expect(screen.getByLabelText('Face and rough turn (G71) Stock on the front face')).toHaveValue('');
    expect(screen.getByText('Not found in proven programs - enter it')).toBeInTheDocument();
    // nothing is generated until asked for
    expect(calls.some((c) => c.path === '/generator/preview')).toBe(false);
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Do this now' })).toHaveTextContent(
        'Press Generate live program',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Generate live program' }));
    expect((await screen.findAllByText(/Stock on the front face not entered/)).length).toBeGreaterThan(0);
  });

  it('never loads a stored program for the part: step 4 is generated from the AI-read table', async () => {
    const { calls } = renderApp(
      '/make?table=4&machine=2',
      makeUser(['engineer']),
      routes(() => READY),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Generate live program' }));
    expect(await screen.findByLabelText('Generated program text')).toHaveTextContent('O1000(P-100)');
    const paths = calls.map((c) => c.path);
    expect(paths.some((x) => x.startsWith('/generator/library'))).toBe(false);
    expect(paths).not.toContain('/drawings/known');
    expect(screen.queryByText(/copied line for line/)).not.toBeInTheDocument();
  });

  it('works in order: generate, engineer accepts, then send', async () => {
    const accepted = {
      id: 77,
      name: 'O1000',
      version: 1,
      status: 'approved',
      source: 'generator',
      machine_name: 'LMW Lathe 1',
      approved_by_name: 'Eng',
    };
    const { calls } = renderApp('/make?table=4&machine=2', makeUser(['engineer', 'operator']), {
      ...routes(() => READY),
      'GET /machines': [{ ...MACHINE, bridge_id: 'bridge-1' }],
      'POST /generator/programs': { program_id: 77, name: 'O1000', version: 1 },
      'POST /programs/77/approve': accepted,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Generate live program' }));
    expect(await screen.findByLabelText('Generated program text')).toHaveTextContent('O1000(P-100)');
    expect(screen.queryByRole('button', { name: /Send to/ })).not.toBeInTheDocument();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept program' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Accept program' }));
    expect(await screen.findByText('Accepted')).toBeInTheDocument();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(
      expect.arrayContaining(['POST /generator/programs', 'POST /programs/77/approve']),
    );
    expect(screen.getByRole('button', { name: 'Send to LMW Lathe 1' })).toBeEnabled();
    expect(screen.getByText('192.168.1.20:8193')).toBeInTheDocument();
  });

  it('blocks acceptance while the 3D simulation reports a safety alarm', async () => {
    sim.errors = 1;
    renderApp(
      '/make?table=4&machine=2',
      makeUser(['engineer']),
      routes(() => READY),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Generate live program' }));
    await screen.findByLabelText('Generated program text');
    expect(await screen.findByText(/Safety alarms: line 12: Rapid move of T04/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept program' })).toBeDisabled();
    expect(screen.getByText(/The 3D simulation found 1 safety alarm/)).toBeInTheDocument();
    expect(sim.stock).toEqual({ diameter: 40, length: 30 });
  });

  it('tells exactly what blocks acceptance on a machine whose control is not entered', async () => {
    renderApp('/make?table=4&machine=2', makeUser(['engineer']), {
      ...routes(() => READY),
      'GET /drawings': DRAWINGS,
      'GET /machines': [{ ...MACHINE, controller: '' }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Generate live program' }));
    await screen.findByLabelText('Generated program text');
    expect(screen.getByRole('button', { name: 'Accept program' })).toBeDisabled();
    expect(screen.getByText(/Enter the control of LMW Lathe 1/)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Do this now' })).toHaveTextContent(
      'the control of LMW Lathe 1',
    );
  });
});

describe('drawing upload', () => {
  it('shows an upload button for engineers before any part is open', async () => {
    renderApp(
      '/make',
      makeUser(['engineer']),
      routes(() => NOT_YET),
    );
    expect(await screen.findByLabelText('Choose drawing file')).toBeInTheDocument();
    expect(screen.getByLabelText('Drawing for the new part')).toBeInTheDocument();
  });

  it('explains why an operator cannot upload', async () => {
    renderApp(
      '/make',
      makeUser(['operator']),
      routes(() => NOT_YET),
    );
    expect(
      await screen.findByText(/needs the Engineer or Programmer role/, { selector: 'p[role="note"]' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Choose drawing file')).not.toBeInTheDocument();
  });
});

describe('real machines', () => {
  it('lists what each machine still needs and offers only the live generator', async () => {
    const bare = { ...MACHINE, controller: '', ip_address: null, bridge_id: null } as unknown as Machine;
    renderApp('/make?table=4&machine=2', makeUser(['programmer']), {
      ...routes(() => NOT_YET),
      'GET /machines': [bare],
    });
    expect(await screen.findByText('Control not confirmed')).toBeInTheDocument();
    expect(screen.getByText('Ethernet IP address not entered')).toBeInTheDocument();
    // the tool list and limits are optional checks, not blockers
    expect(screen.queryByText('Turret tool list empty')).not.toBeInTheDocument();
    expect(screen.getByText(/Optional checks not set up: turret tool list/)).toBeInTheDocument();
    expect(screen.getByText(/No machine can receive a program yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate live program' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /instead/ })).not.toBeInTheDocument();
  });
});

describe('every upload goes to the AI', () => {
  it('uploads the drawing and starts the AI read, with no lookup of stored drawings', async () => {
    const draft = {
      ...TABLE,
      status: 'draft' as const,
      confirmed_by_name: null,
      confirmed_at: null,
    };
    const { calls } = renderApp('/make?table=4', makeUser(['engineer']), {
      ...routes(() => NOT_YET),
      'GET /feature-tables/4': draft,
      'POST /drawings': {
        id: 9,
        part_number: 'P-100',
        filename: 'p.pdf',
        content_type: 'application/pdf',
        size: 10,
        sha256: 'abcdefabcdefabcdef',
        uploaded_by_name: 'E',
        uploaded_at: '2026-11-13T00:00:00Z',
        autofill: null,
      },
    });
    const input = await screen.findByLabelText('Choose drawing file');
    fireEvent.change(input, {
      target: { files: [new File(['%PDF-'], 'p.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() => expect(calls.map((c) => `${c.method} ${c.path}`)).toContain('POST /drawings'));
    const paths = calls.map((c) => c.path);
    expect(paths).not.toContain('/drawings/known');
    expect(paths).not.toContain('/drawings/identify');
    expect(screen.queryByText(/Known drawing/)).not.toBeInTheDocument();
  });
});

describe('confirm table', () => {
  it('says which value is still missing when Confirm is locked', async () => {
    const draft = {
      ...TABLE,
      status: 'draft' as const,
      data: {
        ...TABLE.data,
        header: { ...TABLE.data.header, bar_diameter: { ai: null, value: null, confirmed: false } },
      },
    };
    renderApp('/make?table=4', makeUser(['engineer']), {
      ...routes(() => NOT_YET),
      'GET /feature-tables/4': draft,
    });
    expect(await screen.findByText('Bar diameter', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm table' })).toBeDisabled();
  });
});

describe('dropping a drawing with no part open', () => {
  it('asks for the part number instead of looking the drawing up', async () => {
    const { calls } = renderApp(
      '/make',
      makeUser(['engineer']),
      routes(() => NOT_YET),
    );
    fireEvent.change(await screen.findByLabelText('Choose drawing file'), {
      target: { files: [new File(['%PDF-'], '1627C00501 SLEEVE.pdf', { type: 'application/pdf' })] },
    });
    expect(await screen.findByText(/type its part number in step 1 and press Start/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
