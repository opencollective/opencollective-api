export function setup (client, options = {}){
  const get = client.api.get

  client.register('leaderboards', {
    browse() {
      return get(builders.browse())
    },
  })
}

export default setup

export const builders = {
  browse() {
    return `/leaderboards`
  },
}
