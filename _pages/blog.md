---
layout: blog
title: Plaintext
permalink: /blog/
nav: true
nav_order: 4
---

{% for post in site.posts %}
  <div>
    <a href="{{ post.url | relative_url }}">{{ post.title }}</a>
    <span>{{ post.date | date: "%b %d, %Y" }}</span>
  </div>
{% endfor %}
