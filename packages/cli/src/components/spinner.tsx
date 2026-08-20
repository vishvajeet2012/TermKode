import { registerSpinner } from "opentui-spinner/react";
import { Mode, type ModeType } from "@termkode/shared";
import { useTheme } from "../providers/theme";

// The compiled binary is bundled with tree shaking, which drops a bare
// side-effect import. Registering explicitly keeps <spinner> available in
// release builds as well as in development.
registerSpinner();

type Props = {
  mode?: ModeType;
}

export function Spinner({ mode = Mode.BUILD }: Props) {
  const { colors } = useTheme();
  const activeColor = mode === Mode.PLAN ? colors.planMode : colors.primary;

  return <spinner name="aesthetic" color={activeColor} />;
}
