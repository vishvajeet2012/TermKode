import { createCliRenderer, TextAttributes } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createMemoryRouter, RouterProvider, useRouteError } from "react-router";
import { RootLayout } from "./layouts/root-layout";
import { Home } from "./screens/home";
import { NewSession } from "./screens/new-session";
import { Session } from "./screens/session";

// React Router's built-in error boundary renders HTML elements, which the
// terminal renderer cannot create. Without this screen a route error surfaces
// as an unrelated "Text must be created inside of a text node" crash instead of
// the actual problem.
function RouteError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  return (
    <box flexDirection="column" padding={2} gap={1} width="100%" height="100%">
      <text fg="red" attributes={TextAttributes.BOLD}>
        TermKode hit an error
      </text>
      <text>{message}</text>
      {stack ? <text attributes={TextAttributes.DIM}>{stack}</text> : null}
      <text attributes={TextAttributes.DIM}>Press ctrl+c to quit.</text>
    </box>
  );
}

const router = createMemoryRouter([
  {
    path: "/",
    element: <RootLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Home />, errorElement: <RouteError /> },
      { path: "sessions/new", element: <NewSession />, errorElement: <RouteError /> },
      { path: "sessions/:id", element: <Session />, errorElement: <RouteError /> },
    ],
  },
]);

function App() {
  return <RouterProvider router={router} />;
}

const renderer = await createCliRenderer({
  targetFps: 60,
  exitOnCtrlC: false,
});
createRoot(renderer).render(<App />);
