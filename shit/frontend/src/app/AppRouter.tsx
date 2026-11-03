import { createContext, useContext, type ReactNode } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';

const Content = createContext<ReactNode>(null);
let router: ReturnType<typeof createBrowserRouter> | undefined;

function RouterContent() {
    return useContext(Content);
}

export function AppRouter({ children }: { children: ReactNode }) {
    router ??= createBrowserRouter([{ path: '*', element: <RouterContent /> }], { basename: '/app' });
    return <Content.Provider value={children}><RouterProvider router={router} /></Content.Provider>;
}
