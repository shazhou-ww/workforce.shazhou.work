import { useId, useState } from "react";

export function normalizeScopeValue(value: string) {
  return value.trim().toLowerCase();
}

export function ScopeList({
  label,
  values,
  input,
  onInput,
  onChange,
  kind = "account",
  suggestions = [],
  reservedValues = [],
}: {
  readonly label: string;
  readonly values: readonly string[];
  readonly input: string;
  readonly onInput: (value: string) => void;
  readonly onChange: (values: string[]) => void;
  readonly kind?: "account" | "repository" | "email";
  readonly suggestions?: readonly string[];
  readonly reservedValues?: readonly string[];
}) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const value = normalizeScopeValue(input);
    const account = "[a-z0-9](?:[a-z0-9-]{0,38})";
    const valid =
      kind === "repository"
        ? new RegExp(`^${account}/[a-z0-9_.-]+$`).test(value)
        : kind === "email"
          ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
          : new RegExp(`^${account}$`).test(value);
    if (!valid) {
      setError(
        kind === "repository"
          ? "请输入 owner/name 格式的仓库。"
          : kind === "email"
            ? "请输入有效的统计邮箱。"
            : "请输入有效的 GitHub 账号或组织名。",
      );
      return;
    }
    if (
      [...values, ...reservedValues].some(
        (entry) => normalizeScopeValue(entry) === value,
      )
    ) {
      setError("此条目已添加，请勿重复添加。");
      return;
    }
    onChange([...values, value]);
    onInput("");
    setError(null);
  };
  return (
    <div className="scope-list">
      <label htmlFor={id}>{label}</label>
      <div className="scope-add">
        <input
          id={id}
          value={input}
          placeholder={kind === "repository" ? "owner/name" : undefined}
          list={suggestions.length ? `${id}-suggestions` : undefined}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => {
            onInput(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              add();
            }
          }}
        />
        <button className="secondary-button" type="button" onClick={add}>
          添加
        </button>
      </div>
      {suggestions.length ? (
        <datalist id={`${id}-suggestions`}>
          {suggestions.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {values.length ? (
        <ul className="scope-items">
          {values.map((value) => (
            <li key={value}>
              <span>{value}</span>
              <button
                type="button"
                className="text-button"
                aria-label={`移除 ${value}（${label}）`}
                onClick={() =>
                  onChange(values.filter((entry) => entry !== value))
                }
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-note">尚未添加</p>
      )}
    </div>
  );
}
