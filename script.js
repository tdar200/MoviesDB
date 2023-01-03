const SEARCH_URL = `https://api.themoviedb.org/3/search/movie?api_key=25292bda4c59c8e881ca8fcd4cd330df&query=`;

const urlFunction = (page) => {
  return `https://api.themoviedb.org/3/trending/all/week?api_key=25292bda4c59c8e881ca8fcd4cd330df&page=${page}`;
};

const IMAGE_URL = "https://image.tmdb.org/t/p/w1280";

const form = document.querySelector("#form");
const main = document.querySelector("#main");
const search = document.querySelector("#search");

async function getMovies() {
  let promises = [];
  let arr = [];

  for (let i = 1; i <= 1000; i++) {
    const data = fetch(urlFunction(i));

    promises.push(data);
  }

  const data = await Promise.all(
    promises.map(async (res) => {
      const data = await res;
      const resp = await data.json();

      return resp;

      // console.log(resp);
    })
  );

  // MOVIE
  // Action          28
  // Adventure       12
  // Animation       16
  // Comedy          35
  // Crime           80
  // Documentary     99
  // Drama           18
  // Family          10751
  // Fantasy         14
  // History         36
  // Horror          27
  // Music           10402
  // Mystery         9648
  // Romance         10749
  // Science Fiction 878
  // TV Movie        10770
  // Thriller        53
  // War             10752
  // Western         37

  // TV SHOW
  // Action & Adventure  10759
  // Animation           16
  // Comedy              35
  // Crime               80
  // Documentary         99
  // Drama               18
  // Family              10751
  // Kids                10762
  // Mystery             9648
  // News                10763
  // Reality             10764
  // Sci-Fi & Fantasy    10765
  // Soap                10766
  // Talk                10767
  // War & Politics      10768
  // Western             37

  let averageRatings = 0;
  let length = 0;

  data.forEach((movies) => {
    // console.log(movies);
    movies?.results?.forEach((movie, index, lastIndex) => {
      // if (movie.media_type === "tv") {

      if (
        movie.media_type === "tv" &&
        movie.vote_average >= 7 &&
        movie.vote_count >= 100 &&
        // movie.original_language === "en" &&
        (Number(movie?.first_air_date?.split("-")[0]) >= 1990 ||
          Number(movie?.release_date?.split("-")[0]) >= 1990)
        // &&
        // movie.genre_ids.some((genre) => genre == 10765)
        // movie.genre_ids.some((genre) => genre == 53)
        //  &&

        // movie.original_language === "hi"
      ) {
        // console.log(movie);

        length++;

        averageRatings = +averageRatings + movie.vote_count;

        console.log({ length, averageRatings });

        arr.push(movie);
      }
      // }
    });
  });

  // [...Array(10).keys()].forEach(async (value, index) => {
  //   console.log(value);

  //   fetch(urlFunction(value + 1)).then((res) => {
  //     promises.push(res.json());
  //   });
  //   // const res = await data.json();

  //   // promises.push(res);
  // });

  await Promise.allSettled(promises).then((res) => {
    // console.log(res);
  });

  // const finalBoss = data && (await data.json());

  // const number = vote_average * 1000;

  // let averageScore = +number + +vote_count.toFixed(1);
  console.log(averageRatings / length, "averageRatings");

  arr.sort((a, b) => {
    // console.log({ a, b });
    const mean = (averageRatings / length) * 5;

    const a1 = a.vote_count + mean;
    const a2 = b.vote_count + mean;

    const number1 = (a.vote_average * a.vote_count) / (a.vote_count + a1);
    const number2 = (b.vote_average * b.vote_count) / (b.vote_count + a2);
    return number2 - number1;
  });

  // console.log(arr);

  // arr.sort((a, b) => {
  //   return  b.vote_count - a.vote_count ;
  // });

  showMovies(arr);

  const movieDiv = document.querySelectorAll(".movie");

  if (movieDiv) {
    movieDiv.forEach((movie) =>
      movie.addEventListener("click", (e) => {
        e.preventDefault();
        const title = movie.querySelector(".title h3");
        const movie_title = title.innerHTML.replace(/\s/g, "+");
        // console.log(title.innerHTML, "this is hitting");

        window.open(`https://www.google.com/search?q=${movie_title}`, "_blank");
      })
    );
  }
}
function showMovies(movies) {
  main.innerHTML = "";

  movies.forEach((movie, index) => {
    const {
      title,
      poster_path,
      vote_average,
      overview,
      vote_count,
      name,
      media_type,
      release_date,
      first_air_date,
    } = movie;

    // console.log(movies);

    const number = vote_average;
    // a.vote_average * a.vote_count) / (a.vote_count + 10000)

    let averageScore =
      (+vote_average * +vote_count.toFixed(0)) / (+vote_count + 10000);

    let movieEl = document.createElement("div");

    movieEl.classList.add("movie");

    movieEl.innerHTML = ` 
  <div class="image">
  <img src="${IMAGE_URL + poster_path}" alt=${title} />
  </div>
    <div class="movie-info">
    <div class="title">
    ${index + 1}
    <h3>${title ?? name}</h3>
    <h6>${media_type}</h6>
    </div>
      <div class="votes">
      <div> <p>Rating</p>
      <span class="${getClassByRate(vote_average)}">${vote_average}</span>
       </div>
       <div>    <p>Vote Count</p>
       <span class="vote-count">${vote_count}</span> </div>
       
 
      </div>
      
      <span style="margin: 1rem" class="vote-count">${averageScore}</span>
      
     
       <span class="vote-count">year - ${
         release_date?.split("-")[0] ?? first_air_date?.split("-")[0]
       }</span>
    
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

getMovies();
