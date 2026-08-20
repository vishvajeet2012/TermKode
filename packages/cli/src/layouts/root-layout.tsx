import { Outlet } from "react-router";
import { ToastProvider } from "../providers/toast";
import { DialogProvider } from "../providers/dialog";
import { KeyboardLayerProvider } from "../providers/keyboard-layer";
import { ThemeProvider } from "../providers/theme";
import { ThemedRoot } from "./themed-root";
import { PromptConfigProvider } from "../providers/prompt-config";
import { NeoLensProvider } from "../providers/neolens";
import { PermissionProvider } from "../providers/permission";

export function RootLayout() {
    return (
        <ThemeProvider>
            <ToastProvider>
                <KeyboardLayerProvider>
                    <NeoLensProvider>
                        {/* Dialog content renders as a sibling of the routes,
                            so every context a dialog needs must sit above
                            DialogProvider. */}
                        <PromptConfigProvider>
                            <DialogProvider>
                                {/* Above the routes so every tool call can
                                    reach it, and painted above every dialog so
                                    an approval is never hidden behind one. */}
                                <PermissionProvider>
                                    <ThemedRoot>
                                        <Outlet />
                                    </ThemedRoot>
                                </PermissionProvider>
                            </DialogProvider>
                        </PromptConfigProvider>
                    </NeoLensProvider>
                </KeyboardLayerProvider>
            </ToastProvider>
        </ThemeProvider>
    );
}
