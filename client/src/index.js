import axios from 'axios'

const defineProperty = Object.defineProperty

const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined'

export class ApiClient {
  constructor(options = {}) {

    defineProperty(this, 'options', {
      enumerable: false,
      value: ({ ...DefaultOptions, ...options })
    })

    const storage = isBrowser ? window.localStorage : require('./storage')()

    defineProperty(this, 'storage', {
      enumerable: false,
      value: storage
    })

    defineProperty(this, 'api', {
      enumerable: false,
      value: axios.create({
        baseURL: this.baseURL,
        headers: this.authHeaders
      })
    })
  }

  setDefaults(values = {}) {
    this.instance.defaults = {
      ...this.instance.defaults,
      ...values
    }
  }

  get baseURL() {
    const { protocol, host, prefix } = {
      protocol: '',
      prefix: '/api',
      host: 'localhost',
      ...this.options
    }

    return `${protocol}${host}${prefix}`
  }

  get headers() {
    return {
      ...this.authHeaders
    }
  }

  get authHeaders() {
    return this.isAuthenticated
      ? { Authorization: `Bearer ${this.accessToken}` }
      : {}
  }

  get accessToken() {
    return this.storage.getItem(
      this.options.accessTokenKey
    )
  }

  get isAuthenticated() {
    return !!this.accessToken
  }
}

export default ApiClient
