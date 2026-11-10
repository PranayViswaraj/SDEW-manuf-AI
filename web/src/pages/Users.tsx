import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { ALL_ROLES, type Role, type User } from '../api/types';
import { ErrorBox } from '../components/ui';

export default function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ username: '', full_name: '', password: '', roles: [] as Role[] });

  const load = useCallback(() => {
    api
      .get<User[]>('/users')
      .then(setUsers)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function patch(u: User, body: Partial<Pick<User, 'roles' | 'can_start_machine' | 'is_active'>>) {
    setError(null);
    try {
      await api.patch<User>(`/users/${u.id}`, body);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function toggleRole(u: User, r: Role) {
    const roles = u.roles.includes(r) ? u.roles.filter((x) => x !== r) : [...u.roles, r];
    void patch(u, { roles });
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post<User>('/users', form);
      setForm({ username: '', full_name: '', password: '', roles: [] });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Users</h1>
        <p className="text-sm text-gray-600">
          Roles control what each person can do. <b>Allowed to press Start</b> is a separate list set only by
          an admin.
        </p>
      </div>
      <ErrorBox error={error} />
      <div className="overflow-x-auto rounded border bg-white">
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              {ALL_ROLES.map((r) => (
                <th key={r} className="capitalize">
                  {r}
                </th>
              ))}
              <th>Allowed to press Start</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <div className="font-medium">{u.username}</div>
                  <div className="text-xs text-gray-500">{u.full_name}</div>
                </td>
                {ALL_ROLES.map((r) => (
                  <td key={r}>
                    <input
                      type="checkbox"
                      aria-label={`${u.username} ${r}`}
                      checked={u.roles.includes(r)}
                      onChange={() => toggleRole(u, r)}
                    />
                  </td>
                ))}
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${u.username} can start`}
                    checked={u.can_start_machine}
                    onChange={() => void patch(u, { can_start_machine: !u.can_start_machine })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${u.username} active`}
                    checked={u.is_active}
                    onChange={() => void patch(u, { is_active: !u.is_active })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form onSubmit={create} className="max-w-xl space-y-2 rounded border bg-white p-4">
        <h2 className="font-semibold">Add user</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <input
            className="input"
            placeholder="username"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            required
          />
          <input
            className="input"
            placeholder="full name"
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
          />
          <input
            className="input"
            type="password"
            placeholder="password (8+ chars)"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
          />
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          {ALL_ROLES.map((r) => (
            <label key={r} className="flex items-center gap-1 capitalize">
              <input
                type="checkbox"
                checked={form.roles.includes(r)}
                onChange={() =>
                  setForm({
                    ...form,
                    roles: form.roles.includes(r) ? form.roles.filter((x) => x !== r) : [...form.roles, r],
                  })
                }
              />
              {r}
            </label>
          ))}
        </div>
        <button className="btn-primary">Create user</button>
      </form>
    </div>
  );
}
