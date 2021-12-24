
const SEARCH_URL = `https://api.themoviedb.org/3/search/movie?api_key=25292bda4c59c8e881ca8fcd4cd330df&query=`

const API_URL =
  "https://api.themoviedb.org/3/discover/movie?sort_by=popularity.desc&api_key=25292bda4c59c8e881ca8fcd4cd330df&page=1"

const IMAGE_URL = "https://image.tmdb.org/t/p/w1280";

const form = document.querySelector("#form");
const main = document.querySelector("#main");
const search = document.querySelector("#search");

async function getMovies(url) {
  const res = await fetch(url);
  const data = await res.json();
 
  showMovies(data.results);
}

function showMovies(movies) {
  main.innerHTML = "";

  movies.forEach((movie) => {
    const { title, poster_path, vote_average, overview, vote_count } = movie;

    let movieEl = document.createElement("div");

    movieEl.classList.add("movie");

    movieEl.innerHTML = ` 
  <div class="image">
  <img src="${IMAGE_URL + poster_path}" alt=${title} />
  </div>
    <div class="movie-info">
    <div class="title">
    <h3>${title}</h3>
    </div>
      <div class="votes">
      <div> <p>Rating</p>
      <span class="${getClassByRate(vote_average)}">${vote_average}</span>
       </div>
       <div>    <p>Vote Count</p>
       <span class="vote-count">${vote_count}</span> </div>
 
      </div>
    </div>
    <div class="overview">
      <h3>Overview</h3>
 ${overview}
    </div>
 `;

    main.appendChild(movieEl);
  });
}

function getClassByRate(vote) {
  if (vote >= 8) {
    return "green";
  } else if (vote >= 6) {
    return "orange";
  } else {
    return "red";
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault(); 

  const searchTerm = search.value;

  if (searchTerm && searchTerm !== "") {
    getMovies(SEARCH_URL + searchTerm);

    search.value = "";
  } else {
    window.location.reload();
  }
});



getMovies(API_URL);
