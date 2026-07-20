// Django Backend API Client with JWT Authentication
// Handles all API calls to Django backend with automatic token management

const API_BASE_URL = process.env.NEXT_PUBLIC_DJANGO_API_URL ?? 'http://127.0.0.1:8000/api'

interface AuthTokens {
  access: string
  refresh: string
}

interface AuthResponse {
  access: string
  refresh: string
  user: {
    id: number
    email: string
    username: string
    full_name: string
    role: 'admin' | 'magasin' | 'employer'
    is_confirmed: boolean
    store_id?: number
    magasin_id?: number
    shop_name?: string
    company_name?: string
    position?: string
  }
}

interface ApiErrorResponse {
  detail?: string
  [key: string]: any
}

class DjangoAPIClient {
  private tokens: AuthTokens | null = null
  private isRefreshing = false
  private refreshQueue: Array<(token: string) => void> = []

  constructor() {
    this.loadTokensFromStorage()
  }

  // ==================== Token Management ====================
  private loadTokensFromStorage(): void {
    if (typeof window === 'undefined') return
    const stored = localStorage.getItem('django_tokens')
    if (stored) {
      try {
        this.tokens = JSON.parse(stored)
      } catch (e) {
        console.error('[v0] Failed to parse stored tokens')
      }
    }
  }

  private saveTokensToStorage(tokens: AuthTokens): void {
    if (typeof window === 'undefined') return
    this.tokens = tokens
    localStorage.setItem('django_tokens', JSON.stringify(tokens))
  }

  private clearTokensFromStorage(): void {
    if (typeof window === 'undefined') return
    this.tokens = null
    localStorage.removeItem('django_tokens')
  }

  private async refreshAccessToken(): Promise<string | null> {
    if (!this.tokens?.refresh) return null

    if (this.isRefreshing) {
      return new Promise((resolve) => {
        this.refreshQueue.push(resolve)
      })
    }

    this.isRefreshing = true

    try {
      const response = await fetch(`${API_BASE_URL}/users/refresh/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: this.tokens.refresh }),
      })

      if (!response.ok) {
        this.clearTokensFromStorage()
        window.location.href = '/login'
        return null
      }

      const data = await response.json()
      this.tokens = { ...this.tokens!, access: data.access }
      this.saveTokensToStorage(this.tokens)

      this.refreshQueue.forEach((callback) => callback(data.access))
      this.refreshQueue = []

      return data.access
    } catch (error) {
      console.error('[v0] Token refresh failed:', error)
      this.clearTokensFromStorage()
      return null
    } finally {
      this.isRefreshing = false
    }
  }

  private getAuthHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.tokens?.access && { Authorization: `Bearer ${this.tokens.access}` }),
    }
  }

  // ==================== Core HTTP Methods ====================
  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const normalizedEndpoint = endpoint.startsWith('http')
      ? endpoint
      : `${API_BASE_URL.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`

    const headers = this.getAuthHeaders()
    const requestHeaders = new Headers(headers)
    const extraHeaders = new Headers(options.headers ?? {})
    extraHeaders.forEach((value, key) => requestHeaders.set(key, value))

    let response = await fetch(normalizedEndpoint, {
      ...options,
      headers: requestHeaders,
    })

    if (response.status === 401) {
      const newToken = await this.refreshAccessToken()
      if (!newToken) {
        const error = await response.json().catch(() => ({})) as ApiErrorResponse
        throw new Error(error.detail || 'Authentication failed')
      }

      const refreshedHeaders = new Headers(this.getAuthHeaders())
      const refreshedExtra = new Headers(options.headers ?? {})
      refreshedExtra.forEach((value, key) => refreshedHeaders.set(key, value))

      response = await fetch(normalizedEndpoint, {
        ...options,
        headers: refreshedHeaders,
      })
    }

    if (!response.ok) {
      const contentType = response.headers.get('content-type') || ''
      let errorMessage = `API Error: ${response.status}`
      if (contentType.includes('application/json')) {
        const error = (await response.json()) as ApiErrorResponse
        errorMessage = error.detail
          || (Array.isArray(error.non_field_errors) ? error.non_field_errors[0] : null)
          || Object.entries(error).map(([k, v]) => `${k}: ${Array.isArray(v) ? v[0] : v}`).join(' | ')
          || errorMessage
      } else {
        const text = await response.text()
        if (text) errorMessage = text.slice(0, 200)
      }
      throw new Error(errorMessage)
    }

    // 204/205 and empty bodies are valid success responses (e.g. DELETE)
    if (response.status === 204 || response.status === 205) {
      return undefined as T
    }

    const contentType = response.headers.get('content-type') || ''
    const text = await response.text()
    if (!text) {
      return undefined as T
    }

    if (contentType.includes('application/json')) {
      return JSON.parse(text) as T
    }

    return undefined as T
  }

  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'GET' })
  }

  async post<T>(endpoint: string, data?: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async put<T>(endpoint: string, data?: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async patch<T>(endpoint: string, data?: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async delete<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'DELETE' })
  }

  // ==================== FormData Methods (for file uploads) ====================
  private async requestFormData<T>(
    endpoint: string,
    method: string,
    data: FormData,
  ): Promise<T> {
    const url = `${API_BASE_URL}${endpoint}`
    const headers: Record<string, string> = {}
    if (this.tokens?.access) {
      headers['Authorization'] = `Bearer ${this.tokens.access}`
    }

    let response = await fetch(url, { method, headers, body: data })

    if (response.status === 401) {
      const newToken = await this.refreshAccessToken()
      if (!newToken) throw new Error('Authentication failed')
      headers['Authorization'] = `Bearer ${newToken}`
      response = await fetch(url, { method, headers, body: data })
    }

    if (!response.ok) {
      let errorMsg = `API Error: ${response.status}`
      try {
        const error = await response.json()
        const messages = Object.entries(error)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        errorMsg = messages.join(' | ') || errorMsg
      } catch {}
      throw new Error(errorMsg)
    }

    return response.json()
  }

  async postFormData<T>(endpoint: string, data: FormData): Promise<T> {
    return this.requestFormData<T>(endpoint, 'POST', data)
  }

  async patchFormData<T>(endpoint: string, data: FormData): Promise<T> {
    return this.requestFormData<T>(endpoint, 'PATCH', data)
  }

  // ==================== Blob Methods (for file downloads) ====================
  private async requestBlob(endpoint: string): Promise<{ blob: Blob; filename: string }> {
    const url = `${API_BASE_URL}${endpoint}`
    const headers: Record<string, string> = {}
    if (this.tokens?.access) {
      headers['Authorization'] = `Bearer ${this.tokens.access}`
    }

    let response = await fetch(url, { headers })

    if (response.status === 401) {
      const newToken = await this.refreshAccessToken()
      if (!newToken) throw new Error('Authentication failed')
      headers['Authorization'] = `Bearer ${newToken}`
      response = await fetch(url, { headers })
    }

    if (!response.ok) {
      let errorMsg = `API Error: ${response.status}`
      try {
        const error = await response.json()
        errorMsg = error.detail || errorMsg
      } catch {}
      throw new Error(errorMsg)
    }

    const disposition = response.headers.get('content-disposition') || ''
    const match = disposition.match(/filename="?([^"]+)"?/)
    const filename = match ? match[1] : 'backup.zip'
    const blob = await response.blob()
    return { blob, filename }
  }

  // ==================== Authentication Service ====================
  auth = {
    register: async (
      email: string,
      username: string,
      password: string,
      role: string,
      extraData?: {
        full_name?: string
        company_name?: string
        shop_name?: string
        admin_email?: string
        position?: string
      }
    ) => {
      let backendRole = role
      if (role === 'store_manager') backendRole = 'magasin'
      if (role === 'employee') backendRole = 'employer'

      return this.post<any>('/users/register/', {
        email,
        username,
        password,
        role: backendRole,
        full_name: extraData?.full_name || username,
        ...extraData,
      })
    },

    login: async (email: string, password: string) => {
      const response = await this.post<{ access: string; refresh: string }>('/users/login/', {
        email: email,
        password,
      })
      this.saveTokensToStorage({ access: response.access, refresh: response.refresh })
      const user = await this.auth.getCurrentUser()
      
      return {
        access: response.access,
        refresh: response.refresh,
        user,
      } as unknown as AuthResponse
    },

    logout: async () => {
      const refreshToken = this.tokens?.refresh || (() => {
        if (typeof window === 'undefined') return null
        try {
          const stored = localStorage.getItem('django_tokens')
          return stored ? JSON.parse(stored).refresh : null
        } catch {
          return null
        }
      })()

      if (refreshToken) {
        try {
          await fetch(`${API_BASE_URL}/users/refresh/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh: refreshToken }),
          })
        } catch (error) {
          console.warn('[v0] Logout refresh request failed:', error)
        }
      }

      if (typeof window !== 'undefined') {
        localStorage.clear()
      }

      this.tokens = null
    },

    getCurrentUser: async () => {
      const response = await this.get<any>('/users/me/')
      let mappedRole: 'admin' | 'store_manager' | 'employee' = 'employee'
      if (response.role === 'admin') mappedRole = 'admin'
      else if (response.role === 'magasin') mappedRole = 'store_manager'
      else if (response.role === 'employer') mappedRole = 'employee'

      return {
        id: response.id,
        email: response.email,
        username: response.username,
        full_name: response.full_name || '',
        first_name: response.full_name?.split(' ')[0] || '',
        last_name: response.full_name?.split(' ').slice(1).join(' ') || '',
        phone: response.phone,
        role: mappedRole,
        raw_role: response.role,
        is_approved: response.is_confirmed,
        is_confirmed: response.is_confirmed,
        company_name: response.company_name,
        shop_name: response.shop_name,
        magasin_id: response.magasin_id,
        position: response.position,
      } as any
    },

    approveUser: async (userId: number) => {
      return this.put(`/users/approve/${userId}/`)
    },

    rejectUser: async (userId: number) => {
      return this.post(`/users/reject/${userId}/`)
    },

    getPendingUsers: async () => {
      return this.get<any[]>('/users/pending/')
    },
  }

  // ==================== Products Service ====================
  products = {
    list: async (filters?: { store_id?: number; magasin_id?: number; category?: string }) => {
      const params = new URLSearchParams()
      const storeId = filters?.magasin_id ?? filters?.store_id
      if (storeId) {
        params.append('magasin_id', storeId.toString())
        params.append('store_id', storeId.toString())
      }
      if (filters?.category) params.append('category', filters.category)
      const query = params.toString() ? `?${params.toString()}` : ''
      return this.get<any[]>(`/users/products/${query}`)
    },

    getById: async (id: number) => {
      return this.get<any>(`/users/products/${id}/`)
    },

    create: async (data: any) => {
      return this.post<any>('/users/products/', data)
    },

    update: async (id: number, data: any) => {
      return this.put<any>(`/users/products/${id}/`, data)
    },

    delete: async (id: number) => {
      return this.delete(`/users/products/${id}/`)
    },

    search: async (query: string) => {
      return this.get<any[]>(`/users/products/?search=${encodeURIComponent(query)}`)
    },
  }

  // ==================== Sales Service ====================
  sales = {
    create: async (data: any) => {
      return this.post<any>('/users/sales/', data)
    },

    createBulk: async (data: any) => {
      return this.post<any>('/users/sales/bulk/', data)
    },

    list: async (filters?: { store_id?: number; date_range?: string }) => {
      const params = new URLSearchParams()
      if (filters?.store_id) params.append('store_id', filters.store_id.toString())
      if (filters?.date_range) params.append('date_range', filters.date_range)
      const query = params.toString() ? `?${params.toString()}` : ''
      return this.get<any[]>(`/users/sales/${query}`)
    },

    getById: async (id: number) => {
      return this.get<any>(`/users/sales/${id}/`)
    },

    update: async (id: number, data: any) => {
      return this.put<any>(`/users/sales/${id}/`, data)
    },

    delete: async (id: number) => {
      return this.delete(`/users/sales/${id}/`)
    },

    getByStore: async (storeId: number) => {
      return this.get<any[]>(`/users/sales/?store_id=${storeId}`)
    },

    getRevenueSummary: async (storeId?: number) => {
      const [totals, profit] = await Promise.all([
        this.get<any>('/users/sales/totals/'),
        this.get<any>('/users/sales/profit/'),
      ])
      return {
        ...totals,
        ...profit,
      }
    },
  }

  // ==================== Movements Service ====================
  movements = {
    list: async (filters?: { store_id?: number; movement_type?: string }) => {
      const params = new URLSearchParams()
      if (filters?.store_id) params.append('store_id', filters.store_id.toString())
      if (filters?.movement_type) params.append('movement_type', filters.movement_type)
      const query = params.toString() ? `?${params.toString()}` : ''
      return this.get<any[]>(`/users/movements/${query}`)
    },

    getById: async (id: number) => {
      return this.get<any>(`/users/movements/${id}/`)
    },
  }

  // ==================== Notifications Service ====================
  notifications = {
    list: async () => this.get<any[]>('/users/notifications/'),
    markRead: async (id: number, isRead: boolean) => this.patch<any>(`/users/notifications/${id}/`, { is_read: isRead }),
    markAllRead: async () => this.post<any>('/users/notifications/mark-all-read/'),
    delete: async (id: number) => this.delete<void>(`/users/notifications/${id}/`),
    deleteAll: async () => this.post<void>('/users/notifications/delete-all/'),
    bulkRead: async (ids: number[]) => this.post<any>('/users/notifications/bulk-read/', { ids }),
    bulkDelete: async (ids: number[]) => this.post<void>('/users/notifications/bulk-delete/', { ids }),
  }

  // ==================== Users Service ====================
  users = {
    list: async (role?: string) => {
      return this.get<any[]>('/users/magasins/users/')
    },

    getById: async (id: number) => {
      return this.get<any>(`/users/me/`)
    },

    update: async (id: number, data: any) => {
      return this.put<any>(`/users/role/${id}/`, data)
    },

    delete: async (id: number) => {
      return this.delete(`/users/delete/${id}/`)
    },

    updateProfile: async (data: any) => {
      return this.patch<any>('/users/me/', data)
    },

    getEmployeesByStore: async (storeId: number) => {
      const list = await this.get<any[]>('/users/magasins/users/')
      const found = list.find((m: any) => m.magasin_id === storeId)
      return found ? found.employers : []
    },
  }

  // ==================== Dashboard Service ====================
  dashboard = {
    getStats: async (storeId?: number) => {
      const res = await this.get<any>('/users/dashboard/')
      return res.kpis
    },

    getTopProducts: async (storeId?: number, limit: number = 5) => {
      const res = await this.get<any>('/users/dashboard/')
      return res.lists?.top_products || []
    },

    getRevenueChart: async (storeId?: number, period: string = 'monthly') => {
      const res = await this.get<any>('/users/dashboard/')
      return res.lists?.recent_sales || []
    },

    getSalesAnalytics: async (storeId?: number) => {
      return this.get<any>('/users/dashboard/')
    },
  }

  // ==================== Transfers Service ====================
  transfers = {
    transfer: async (
      sourceId: number,
      destinationId: number,
      items: { product_id: number; quantity: number; variant_id?: number }[]
    ) => {
      return this.post<any>('/users/transfer/products/', {
        source_magasin_id: sourceId,
        destination_magasin_id: destinationId,
        items,
      })
    },
    list: async () => {
      return this.get<any[]>('/users/magasins/users/')
    },

    getProfitByMagasins: async () => {
      return this.get<any>('/users/sales/profit-by-magasins/')
    },

    create: async (data: any) => {
      return this.post<any>('/users/magasins/users/', data)
    },

    update: async (id: number, data: any) => {
      return this.put<any>(`/users/magasins/users/${id}/`, data)
    },

    delete: async (id: number) => {
      return this.delete(`/users/magasins/users/${id}/`)
    },

    getStoreByManager: async (managerId: number) => {
      const list = await this.stores.list()
      return list.find((m: any) => m.manager?.id === managerId) || null
    },
  }

  // ==================== Suppliers Service ====================
  suppliers = {
    list: async () => {
      return []
    },

    getById: async (id: number) => {
      return null
    },

    create: async (data: any) => {
      return {}
    },

    update: async (id: number, data: any) => {
      return {}
    },

    delete: async (id: number) => {
      return {}
    },
  }

  // ==================== Backup Service (admin only) ====================
  backup = {
    export: async () => {
      return this.requestBlob('/users/backup/export/')
    },

    import: async (file: File) => {
      const fd = new FormData()
      fd.append('file', file)
      return this.postFormData<{ detail: string }>('/users/backup/import/', fd)
    },
  }

  // ==================== Chat Service ====================
  chat = {
    users: async () => {
      return this.get<any[]>('/users/chat/users/')
    },
    history: async (params?: { recipient_id?: number; room_name?: string }) => {
      const urlParams = new URLSearchParams()
      if (params?.recipient_id) urlParams.append('recipient_id', params.recipient_id.toString())
      if (params?.room_name) urlParams.append('room_name', params.room_name)
      const query = urlParams.toString() ? `?${urlParams.toString()}` : ''
      return this.get<any[]>(`/users/chat/history/${query}`)
    }
  }

  // ==================== Token Status ====================
  isAuthenticated(): boolean {
    return !!this.tokens?.access
  }

  getAccessToken(): string | null {
    return this.tokens?.access || null
  }
}

export const djangoClient = new DjangoAPIClient()
export type { AuthResponse, AuthTokens }

