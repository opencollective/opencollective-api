export function register (client, options = {}){
  const get = client.api.get

  client.register('groups', {
    find: (slug) => (
      get(builders.findBySlug(slug))
    ),

    details: (slug) => (
      get(builders.findBySlug(slug)).then(user => presenters.details(user))
    ),

    activeUsers: (slug) => (
      get(builders.activeUsers(slug))
    )
  })
}

export default register

export const builders = {
  findBySlug (slug) {
    return `/groups/${slug.toLowerCase()}`
  },

  activeUsers(slug) {
    return `/groups/${slug.toLowerCase()}/users?filter=active`
  }
}

export const presenters = {
  details(user = {}) {
    let description = '';

    if (user.groups.length > 0) {
      const belongsTo = user.groups.filter(({role}) => role === 'MEMBER')
      const backing = user.groups.filter(({role}) => role === 'BACKER')

      if (belongsTo.length > 0) {
        description += `a member of ${belongsTo.length} collectives`;
      }

      if (backing.length > 0) {
        if (description.length > 0) description += ' and ';
        description += `supporting ${backing.length} collectives`;
      }

      user.groups.sort((a, b) => (b.members - a.members));
      description += ' including ';
      const includingGroups = user.groups.slice(0,3).map((g) => g.name);
      description += includingGroups.join(', ');
    }

    return {
      url: `/${user.username}`,
      title: `${user.name} is on OpenCollective`,
      description: `${user.name} is ${description}`,
      twitter: `@${user.twitterHandle}`,
      image: user.avatar
    }
  }
}
