import { useState } from "react";
import { useFieldError } from "../../app/errors";
import { Checkbox, TextField } from "@heybe/ui";

export function PasswordInputs({
  isNew,
  password,
  confirm,
  onChange,
}: {
  isNew: boolean;
  password: string;
  confirm: string;
  onChange: (password: string, confirm: string) => void;
}) {
  const [changing, setChanging] = useState(isNew);
  const passwordError = useFieldError("password");
  const confirmError = useFieldError("passwordConfirm");
  return (
    <div className="flex flex-col gap-2">
      {!isNew && (
        <Checkbox
          label="Change password"
          checked={changing}
          onChange={(e) => {
            setChanging(e.target.checked);
            if (!e.target.checked) onChange("", "");
          }}
        />
      )}
      {changing && (
        <>
          <TextField
            label="Password"
            type="password"
            autoComplete="new-password"
            value={password}
            error={passwordError}
            onChange={(e) => onChange(e.target.value, confirm)}
          />
          <TextField
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            error={confirmError}
            onChange={(e) => onChange(password, e.target.value)}
          />
        </>
      )}
    </div>
  );
}
