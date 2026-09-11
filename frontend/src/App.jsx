import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';
import { Layout } from './components/Layout.jsx';
import { ProtectedRoute } from './components/ProtectedRoute.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';

import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Customers from './pages/Customers.jsx';
import CustomerDetail from './pages/CustomerDetail.jsx';
import Products from './pages/Products.jsx';
import NewSale from './pages/NewSale.jsx';
import Sales from './pages/Sales.jsx';
import SaleDetail from './pages/SaleDetail.jsx';
import Receivables from './pages/Receivables.jsx';
import Integrations from './pages/Integrations.jsx';
import Users from './pages/Users.jsx';
import Audit from './pages/Audit.jsx';
import Branches from './pages/Branches.jsx';
import Inventory from './pages/Inventory.jsx';
import Catalog from './pages/Catalog.jsx';

export default function App() {
    return (
        <ErrorBoundary>
            <BrowserRouter>
                <ToastProvider>
                    <AuthProvider>
                        <Routes>
                            <Route path="/login" element={<Login />} />
                            <Route
                                element={
                                    <ProtectedRoute>
                                        <Layout />
                                    </ProtectedRoute>
                                }
                            >
                                <Route path="/" element={<Dashboard />} />
                                <Route path="/clientes" element={<Customers />} />
                                <Route path="/clientes/:id" element={<CustomerDetail />} />
                                <Route path="/productos" element={<Products />} />
                                <Route path="/ventas" element={<Sales />} />
                                <Route path="/ventas/nueva" element={<NewSale />} />
                                <Route path="/ventas/:id" element={<SaleDetail />} />
                                <Route
                                    path="/cobranza"
                                    element={
                                        <ProtectedRoute permission={['receivables.view', 'receivables.view.own']}>
                                            <Receivables />
                                        </ProtectedRoute>
                                    }
                                />
                                <Route
                                    path="/sucursales"
                                    element={
                                        <ProtectedRoute permission="branches.view">
                                            <Branches />
                                        </ProtectedRoute>
                                    }
                                />
                                <Route
                                    path="/inventario"
                                    element={
                                        <ProtectedRoute permission={['inventory.view', 'inventory.view.own']}>
                                            <Inventory />
                                        </ProtectedRoute>
                                    }
                                />
                                <Route
                                    path="/catalogo"
                                    element={
                                        <ProtectedRoute permission="products.view">
                                            <Catalog />
                                        </ProtectedRoute>
                                    }
                                />
                                <Route
                                    path="/usuarios"
                                    element={
                                        <ProtectedRoute permission="users.view">
                                            <Users />
                                        </ProtectedRoute>
                                    }
                                />
                                <Route
                                    path="/bitacora"
                                    element={
                                        <ProtectedRoute permission="audit.view">
                                            <Audit />
                                        </ProtectedRoute>
                                    }
                                />
                                <Route
                                    path="/integraciones"
                                    element={
                                        <ProtectedRoute permission="integrations.manage">
                                            <Integrations />
                                        </ProtectedRoute>
                                    }
                                />
                            </Route>
                            <Route path="*" element={<Navigate to="/" replace />} />
                        </Routes>
                    </AuthProvider>
                </ToastProvider>
            </BrowserRouter>
        </ErrorBoundary>
    );
}
